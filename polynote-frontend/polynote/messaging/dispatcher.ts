import match from "../util/match";
import * as messages from "../data/messages";
import {HandleData, ModifyStream, NotebookUpdate, ReleaseHandle, TableOp} from "../data/messages";
import {CellMetadata} from "../data/data";
import {
    ResultValue,
    ServerErrorWithCause
} from "../data/result";
import {Disposable, StateHandler, StateView} from "../state/state_handler";
import {CellState, NotebookState, NotebookStateHandler} from "../state/notebook_state";
import {ServerState, ServerStateHandler} from "../state/server_state";
import {ConnectionStatus, SocketStateHandler} from "../state/socket_state";
import {About} from "../ui/component/about";
import {ValueInspector} from "../ui/component/value_inspector";
import {
    collect,
    diffArray,
    partition
} from "../util/helpers";
import {Either} from "../data/codec_types";
import {DialogModal} from "../ui/layout/modal";
import {ClientInterpreter, ClientInterpreters} from "../interpreter/client_interpreter";
import {OpenNotebooksHandler} from "../state/preferences";
import {ClientBackup} from "../state/client_backup";
import {ErrorStateHandler} from "../state/error_state";

/**
 * The Dispatcher is used to handle actions initiated by the UI.
 *
 * It connects a `socket` instance with the UI `state`. Only the Dispatcher should be sending messages on a `socket`.
 */
export abstract class MessageDispatcher<S, H extends StateHandler<S> = StateHandler<S>> extends Disposable{
    protected constructor(protected socket: SocketStateHandler, protected handler: H) {
        super()
        handler.onDispose.then(() => {
            this.socket.close()
        })
    }

    get state() {
        return this.handler.state;
    }
}

export class NotebookMessageDispatcher extends MessageDispatcher<NotebookState, NotebookStateHandler> {
    constructor(socket: SocketStateHandler, state: NotebookStateHandler) {
        super(socket, state);
        // when the socket is opened, send a KernelStatus message to request the current status from the server.
        socket.view("status").addObserver(next => {
            if (next === "connected") {
                socket.send(new messages.KernelStatus(new messages.KernelBusyState(false, false)))
            }
        }, this);
        const errorView = socket.view("error")
        errorView.addObserver(err => {
            if (err) {
                ErrorStateHandler.addKernelError(state.state.path, err.error)
            }
        }, this)

        state.view("activeSignature").addObserver(sig => {
            if (sig) {
                this.socket.send(new messages.ParametersAt(sig.cellId, sig.offset))
            }
        }, this)

        state.view("activeCompletion").addObserver(sig => {
            if (sig) {
                this.socket.send(new messages.CompletionsAt(sig.cellId, sig.offset, []))
            }
        }, this)

        state.updateHandler.addObserver(updates => {
            if (updates.length > 0) {
                console.log("got updates to send", updates)
                updates.forEach(update => this.sendUpdate(update))
                state.updateHandler.update(() => [])
            }
        }, this)

        const cells: Record<number, StateView<CellState>> = {};
        const cellsState = state.view("cells");
        state.view("cellOrder").addObserver((newOrder, prevOrder) => {
            const [_, added] = diffArray(prevOrder, newOrder);

            added.forEach(id => {
                const handler = cellsState.view(id)
                cells[id] = handler
                this.watchCell(handler)
            })
        }, this)
    }

    private watchCell(cellView: StateView<CellState>) {
        const id = cellView.state.id;
        console.log("dispatcher: watching cell", id)

        cellView.view("currentSelection").addObserver(range => {
            if (range) {
                this.socket.send(new messages.CurrentSelection(id, range))
            }
        }, this)

    }

    private sendUpdate(upd: NotebookUpdate) {
        this.socket.send(upd)
        ClientBackup.updateNb(this.handler.state.path, upd)
            .catch(err => console.error("Error backing up update", err))
    }

    /*******************************
     ** Task management methods **
     *******************************/

    cancelTasks() {
        this.socket.send(new messages.CancelTasks(this.state.path))
    }

    /*******************************
     ** UI methods (which don't   **
     ** really belong here)       **
     *******************************/

    showValueInspector(result: ResultValue, tab?: string) {
        ValueInspector.get.inspect(this, this.handler, result, tab)
    }

    hideValueInspector() {
        ValueInspector.get.hide()
    }

    /*******************************
     ** Notebook management methods **
     *******************************/

    clearOutput() {
        this.socket.send(new messages.ClearOutput())
    }

    downloadNotebook() {
        const path = window.location.pathname + "?download=true"
        const link = document.createElement('a');
        link.setAttribute("href", path);
        link.setAttribute("download", this.state.path);
        link.click()
    }

    /*******************************
     ** Kernel management methods **
     *******************************/

    reconnect(onlyIfClosed: boolean): void {
        console.log("Attempting to reconnect to notebook")
        this.socket.reconnect(onlyIfClosed)
        const errorView = this.socket.lens("error")
        errorView.addObserver(err => {
            // if there was an error on reconnect, push it to the notebook state so it can be displayed
            if (err) {
                console.error("error on reconnecting notebook", err)
                ErrorStateHandler.addKernelError(this.handler.state.path, err.error)
            }
        }, this)
        this.socket.view("status").addObserver(status => {
            if (status === "connected") {
                this.handler.update(s => {
                    return {
                        ...s,
                        errors: [] // any errors from before are no longer relevant, right?
                    }
                })
                errorView.dispose()
            }
        }, errorView)
    }

    kernelCommand(command: "start" | "kill") {
        if (command === "start") {
            this.socket.send(new messages.StartKernel(messages.StartKernel.NoRestart));
        } else if (command === "kill") {
            if (confirm("Kill running kernel? State will be lost.")) {
                this.socket.send(new messages.StartKernel(messages.StartKernel.Kill));
            }
        }
    }

    /*******************************
     ** Cell management methods **
     *******************************/

    runCells(cellIds: number[]) {
        // empty cellIds means run all of them!
        if (cellIds.length === 0) {
            cellIds = this.state.cellOrder
        }

        cellIds = collect(cellIds, id => this.state.cells[id]?.language !== "text" ? id : undefined);

        const [clientCells, serverCells] = partition(cellIds, id => {
            const cell = this.state.cells[id]
            if (cell) {
                return Object.keys(ClientInterpreters).includes(cell.language)
            } else {
                console.warn("Run requested for cell with ID", id, "but a cell with that ID was not found in", this.state.cells)
                return true // should this fail?
            }
        })
        clientCells.forEach(id => {
            const idx = cellIds.indexOf(id)
            const prevId = cellIds[idx - 1]
            const clientInterpreter = ClientInterpreter.forPath(this.state.path);
            if (clientInterpreter) {
                clientInterpreter.runCell(id, this, prevId)
            } else {
                const cell = this.state.cells[id];
                const message = `Missing Client Interpreter for cell ${cell.id} of type ${cell.language}`
                console.error(message)
                ErrorStateHandler.addKernelError(this.handler.state.path, new ServerErrorWithCause("Missing Client Interpreter", message, []))
            }
        })
        this.socket.send(new messages.RunCell(serverCells));
    }

    runActiveCell() {
        const id = this.handler.state.activeCellId;
        if (id !== undefined) {
            this.runCells([id]);
        }
    }

    runToActiveCell() {
        const state = this.handler.state;
        const id = state.activeCellId;
        if (id) {
            const activeIdx = state.cellOrder.indexOf(id)
            const cellsToRun = state.cellOrder.slice(0, activeIdx + 1);
            if (cellsToRun.length > 0) {
                this.runCells(cellsToRun)
            }
        }
    }

    /*******************************
     ** Data streaming methods **
     *******************************/

    requestDataBatch(handleType: number, handleId: number, batchSize: number) {
        this.socket.send(new HandleData(handleType, handleId, batchSize, Either.right([])))
    }

    modifyDataStream(handleId: number, mods: TableOp[]) {
        this.socket.send(new ModifyStream(handleId, mods))
    }

    stopDataStream(handleType: number, handleId: number) {
        this.socket.send(new ReleaseHandle(handleType, handleId))
    }
}

// TODO: should this be a singleton too?
export class ServerMessageDispatcher extends MessageDispatcher<ServerState>{
    constructor(socket: SocketStateHandler) {
        super(socket, ServerStateHandler.get);

        const errorView = socket.view("error")
        errorView.addObserver(err => {
            if (err) {
                ErrorStateHandler.addServerError(err.error)
            }
        }, this)

        this.handler.view("openNotebooks").addObserver(nbs => {
            OpenNotebooksHandler.update(() => nbs)
        }, this)
    }

    /*******************************
     ** Server management methods **
     *******************************/

    reconnect(onlyIfClosed: boolean) {
        console.warn("Attempting to reconnect to server") // TODO: once we have a proper place for server errors, we can display this log there.
        this.socket.reconnect(onlyIfClosed)
        const errorView = this.socket.lens("error")
        errorView.addObserver(err => {
            if (err) {
                // We don't want to reload if the connection is offline, instead we just want to display the
                // error to the user
                const reload = err.status === ConnectionStatus.ONLINE
                if (reload) {
                    console.error("Error reconnecting, trying to reload the page")
                    document.location.reload();
                } else {
                    ErrorStateHandler.addServerError(err.error)
                }
            }
        }, this)
        // TODO: depending on how complicated reconnecting is, maybe we should just reload the page every time?
        this.socket.view("status").addObserver(status => {
            if (status === "connected") {
                console.warn("Reconnected successfully, now reconnecting to notebook sockets")
                this.handler.update(s => {
                    return {
                        ...s,
                        errors: [] // any errors from before are no longer relevant, right?
                    }
                })
                ServerStateHandler.reconnectNotebooks(onlyIfClosed)
                errorView.dispose()
            }
        }, errorView)
    }

    requestNotebookList() {
        this.socket.send(new messages.ListNotebooks([]))
    }

    requestRunningKernels() {
        this.socket.send(new messages.RunningKernels([]))
    }

    createNotebook(path?: string, content?: string) {
        const waitForNotebook = (nbPath: string) => {
            const disposable = new Disposable()
            const nbs = this.handler.view("notebooks")
            nbs.addObserver((current, prev) => {
                const [added, _] = diffArray(Object.keys(current), Object.keys(prev))
                added.forEach(newNb => {
                    if (newNb.includes(nbPath)) {
                        disposable.dispose()
                        ServerStateHandler.loadNotebook(newNb, true).then(nbInfo => {
                            nbInfo.handler.update1("config", conf => ({...conf, open: true}))
                            ServerStateHandler.selectNotebook(newNb)
                        })
                    }
                })
            }, disposable)
        }
        if (path) {
            this.socket.send(new messages.CreateNotebook(path, content))
            waitForNotebook(path)
        } else {
            new DialogModal('Create Notebook', 'path/to/new notebook name', 'Create').show().then(newPath => {
                this.socket.send(new messages.CreateNotebook(newPath, content))
                waitForNotebook(newPath)
            })
        }
    }

    renameNotebook(oldPath: string, newPath?: string) {
        if (newPath) {
            this.socket.send(new messages.RenameNotebook(oldPath, newPath))
        } else {
            new DialogModal('Rename Notebook', oldPath, 'Rename').show().then(newPath => {
                this.socket.send(new messages.RenameNotebook(oldPath, newPath))
            })
        }
    }

    copyNotebook(oldPath: string, newPath?: string) {
        if (newPath) {
            this.socket.send(new messages.CopyNotebook(oldPath, newPath))
        } else {
            new DialogModal('Copy Notebook', oldPath, 'Copy').show().then(newPath => {
                this.socket.send(new messages.CopyNotebook(oldPath, newPath))
            })
        }
    }

    deleteNotebook(path: string) {
        if (confirm(`Permanently delete ${path}?`)) {
            this.socket.send(new messages.DeleteNotebook(path))
        }
    }

    /*******************************
     ** UI methods (which don't   **
     ** really belong here)       **
     *******************************/

    viewAbout(section: string) {
        About.show(this, section)
    }
}
