const { contextBridge, ipcRenderer } = require('electron');

// Bridge segura: o popup só consegue chamar essas funções específicas.
contextBridge.exposeInMainWorld('trayAPI', {
    /**
     * Inscreve um callback para receber atualizações de estado em tempo real.
     * O main process chama webContents.send('tray:state', state) sempre que algo muda.
     */
    onStateUpdate: (callback) => {
        ipcRenderer.on('tray:state', (_evt, state) => callback(state));
    },

    /**
     * Envia uma ação para o main process. Lista esperada:
     *  - 'request-state'                 → solicita estado inicial
     *  - 'check-updates'                 → autoUpdater.checkForUpdates
     *  - 'update-download-and-install'   → baixar com autoInstall=true
     *  - 'update-install'                → quitAndInstall (versão já baixada)
     *  - 'update-skip' { version }       → marca versão como pulada
     *  - 'fix-queue'                     → limpa fila do spooler
     *  - 'test-print'                    → imprime página de teste
     *  - 'open-dashboard'                → mostra janela principal
     *  - 'quit'                          → encerra o agent
     *  - 'close'                         → só fecha o popup (Esc)
     */
    send: (action, payload) => {
        if (typeof action !== 'string') return;
        ipcRenderer.send('tray:action', { action, payload });
    },
});
