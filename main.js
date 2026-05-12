const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { isValidPrinterName } = require('./src/utils/printerValidator');

// ── Auto-update via GitHub Releases ──────────────────────────────────────────
// Estratégia profissional, controle MANUAL:
//  - autoDownload=false: detecta versão nova, NÃO baixa sem consentimento.
//  - autoInstallOnAppQuit=false: NÃO aplica sozinho — usuário decide quando.
//  - Skipped versions: persistidas em data/update-prefs.json. Versão pulada
//    não dispara notificação na próxima checagem (mas se sair uma 3.8.0
//    posterior, ela aparece normalmente).
//  - Checa só no boot + via ação manual (botão na UI ou item do tray).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowDowngrade = false;

// Persistência de preferências (skipped versions)
const UPDATE_PREFS_FILE = path.join(app.getPath('userData'), 'update-prefs.json');

function readUpdatePrefs() {
    try {
        if (fs.existsSync(UPDATE_PREFS_FILE)) {
            const raw = fs.readFileSync(UPDATE_PREFS_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                skippedVersions: Array.isArray(parsed.skippedVersions) ? parsed.skippedVersions : [],
            };
        }
    } catch (e) {
        console.warn('[autoUpdater] falha ao ler update-prefs:', e.message);
    }
    return { skippedVersions: [] };
}

function writeUpdatePrefs(prefs) {
    try {
        fs.mkdirSync(path.dirname(UPDATE_PREFS_FILE), { recursive: true });
        fs.writeFileSync(UPDATE_PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
    } catch (e) {
        console.warn('[autoUpdater] falha ao salvar update-prefs:', e.message);
    }
}

let updateState = {
    status: 'idle',        // idle | checking | available | downloading | ready | error | skipped
    info: null,            // { version, releaseNotes, releaseName, releaseDate, files }
    error: null,
    downloadProgress: 0,   // 0–100
    skippedVersions: readUpdatePrefs().skippedVersions,
    currentVersion: app.getVersion(),
    lastCheckedAt: null,   // ISO timestamp da última checagem concluída (ok ou erro)
};

function pushUpdateStateToAgent() {
    if (!agentProcess) return;
    try {
        agentProcess.send({
            type: 'UPDATE_STATUS',
            payload: {
                status: updateState.status,
                version: updateState.info && updateState.info.version,
                releaseNotes: updateState.info && (updateState.info.releaseNotes || ''),
                releaseName: updateState.info && (updateState.info.releaseName || ''),
                releaseDate: updateState.info && (updateState.info.releaseDate || null),
                currentVersion: updateState.currentVersion,
                error: updateState.error,
                progress: updateState.downloadProgress,
                skippedVersions: updateState.skippedVersions,
                lastCheckedAt: updateState.lastCheckedAt,
            },
        });
    } catch { /* ignore */ }
}

// ── Ações (chamadas via IPC do agent.js, originadas dos endpoints REST) ─────

function actionCheckForUpdates() {
    if (!app.isPackaged) return Promise.resolve({ ok: false, error: 'Não disponível em modo dev.' });
    return autoUpdater.checkForUpdates()
        .then((res) => ({ ok: true, hasUpdate: !!(res && res.updateInfo) }))
        .catch((err) => ({ ok: false, error: err && err.message }));
}

function actionStartDownload() {
    if (!app.isPackaged) return Promise.resolve({ ok: false, error: 'Não disponível em modo dev.' });
    if (!updateState.info) return Promise.resolve({ ok: false, error: 'Nenhuma atualização disponível.' });
    if (updateState.status === 'downloading') return Promise.resolve({ ok: false, error: 'Download já em andamento.' });
    if (updateState.status === 'ready') return Promise.resolve({ ok: true, alreadyReady: true });

    updateState.status = 'downloading';
    updateState.downloadProgress = 0;
    pushUpdateStateToAgent();
    updateTrayMenu();

    return autoUpdater.downloadUpdate()
        .then(() => ({ ok: true }))
        .catch((err) => {
            updateState.status = 'error';
            updateState.error = err && err.message;
            pushUpdateStateToAgent();
            updateTrayMenu();
            return { ok: false, error: err && err.message };
        });
}

function actionInstallNow() {
    if (updateState.status !== 'ready') {
        return { ok: false, error: 'Atualização ainda não foi baixada.' };
    }
    setTimeout(() => {
        try {
            app.isQuitting = true;
            if (agentProcess) {
                try { agentProcess.kill(); } catch { /* ignore */ }
            }
            // (isSilent=false, isForceRunAfter=true) — abre instalador e reabre o app após.
            autoUpdater.quitAndInstall(false, true);
        } catch (e) {
            console.error('[autoUpdater] falha ao instalar update:', e);
        }
    }, 500);
    return { ok: true };
}

function actionSkipVersion(version) {
    if (!version || typeof version !== 'string') return { ok: false, error: 'Versão inválida.' };
    const prefs = readUpdatePrefs();
    if (!prefs.skippedVersions.includes(version)) {
        prefs.skippedVersions.push(version);
        writeUpdatePrefs(prefs);
    }
    updateState.skippedVersions = prefs.skippedVersions;
    // Se a versão pulada é a atualmente sinalizada, limpa o estado para tirar o banner
    if (updateState.info && updateState.info.version === version) {
        updateState.status = 'skipped';
        updateState.info = null;
        updateState.downloadProgress = 0;
    }
    pushUpdateStateToAgent();
    updateTrayMenu();
    return { ok: true, skippedVersions: prefs.skippedVersions };
}

let mainWindow;
let persistentSpoolerWindow = null;
let tray;
let agentProcess;

// Estado para desenhar o menu
let agentState = {
    status: 'Iniciando...',
    printerName: 'Detectando...',
    printerStatus: '...'
};

// 🔒 SINGLE INSTANCE LOCK
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        // Fix notification name on Windows
        app.setAppUserModelId('OnTrack Agent');

        // Configurar inicialização automática (Apenas em Produção)
        if (app.isPackaged) {
            app.setLoginItemSettings({
                openAtLogin: true,
                path: process.execPath,
                args: ['--hidden']
            });
        }

        createPersistentSpooler(); // Cria o Spooler Invisível
        startAgent(); // Inicia o motor

        // Verifica se deve abrir a janela ou ficar na bandeja
        // Se houver '--hidden' nos argumentos, não mostramos a janela (auto-restart)
        const shouldShow = !process.argv.includes('--hidden');
        createWindow(shouldShow);
        createTray(); // Cria o ícone

        registerDeviceChangeWatcher(); // Detecta plug/unplug sem polling

        // Auto-update: checa 1× no boot (cadência simples e leve). Se houver
        // versão nova, baixa em background e marca como pronta para instalar
        // ao próximo "Reiniciar e atualizar" (tray) ou ao app.quit().
        // Pula em desenvolvimento (sem app.isPackaged) para não tentar consultar GitHub.
        if (app.isPackaged) {
            // Pequeno delay para não competir com o boot do agent
            setTimeout(() => {
                autoUpdater.checkForUpdates().catch((err) => {
                    console.warn('[autoUpdater] checagem inicial falhou:', err && err.message);
                });
            }, 8000);
        }
    });
}

// ── Listeners do autoUpdater ────────────────────────────────────────────────
autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    pushUpdateStateToAgent();
});

autoUpdater.on('update-available', (info) => {
    updateState.lastCheckedAt = new Date().toISOString();
    // Versão pulada anteriormente? Silencia (só registra no estado, sem alerta).
    if (updateState.skippedVersions.includes(info.version)) {
        console.log(`[autoUpdater] versão ${info.version} disponível mas foi pulada pelo usuário.`);
        updateState.status = 'skipped';
        updateState.info = info;
        pushUpdateStateToAgent();
        updateTrayMenu();
        return;
    }
    updateState.status = 'available'; // NÃO baixa automaticamente — espera ação
    updateState.info = info;
    console.log(`[autoUpdater] versão ${info.version} disponível — aguardando decisão do usuário.`);
    showNotification({
        title: 'Atualização disponível',
        body: `OnTrack Agent ${info.version} pronto para instalar. Abra o painel para escolher.`,
    });
    pushUpdateStateToAgent();
    updateTrayMenu();
});

autoUpdater.on('update-not-available', () => {
    updateState.status = 'idle';
    updateState.info = null;
    updateState.lastCheckedAt = new Date().toISOString();
    pushUpdateStateToAgent();
    updateTrayMenu();
});

autoUpdater.on('download-progress', (progress) => {
    updateState.downloadProgress = Math.round(progress.percent || 0);
    pushUpdateStateToAgent();
});

autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'ready';
    updateState.info = info;
    updateState.downloadProgress = 100;
    console.log(`[autoUpdater] versão ${info.version} pronta para aplicar.`);
    showNotification({
        title: 'Atualização pronta',
        body: `${info.version} baixada. Clique em "Instalar agora" no painel quando preferir.`,
    });
    pushUpdateStateToAgent();
    updateTrayMenu();
});

autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.error = (err && err.message) || String(err);
    updateState.lastCheckedAt = new Date().toISOString();
    console.warn('[autoUpdater] erro:', updateState.error);
    pushUpdateStateToAgent();
    updateTrayMenu();
});

// Detecta plug/unplug de dispositivos USB (impressoras, dongles)
// via WM_DEVICECHANGE. Custo idle = 0. Dispara um único refresh no agent.
let lastDeviceChangeAt = 0;
function registerDeviceChangeWatcher() {
    try {
        // Electron expõe powerMonitor e algumas mensagens; usamos hookWindowMessage
        // numa BrowserWindow oculta para receber WM_DEVICECHANGE (0x0219).
        const hookWin = new BrowserWindow({
            show: false,
            width: 1, height: 1,
            webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
        });
        const WM_DEVICECHANGE = 0x0219;
        if (typeof hookWin.hookWindowMessage === 'function') {
            hookWin.hookWindowMessage(WM_DEVICECHANGE, () => {
                const now = Date.now();
                // debounce 1s — drivers podem disparar várias mensagens seguidas
                if (now - lastDeviceChangeAt < 1000) return;
                lastDeviceChangeAt = now;
                if (agentProcess) {
                    agentProcess.send({ type: 'DEVICE_CHANGE' });
                }
            });
        }
    } catch (e) {
        console.error('[MAIN] Falha ao registrar WM_DEVICECHANGE:', e.message);
    }
}

// Escuta mudanças de tema do SO para atualizar ícones em tempo real
nativeTheme.on('updated', () => {
    updateTrayMenu();
});

// 0. SPOOLER PERSISTENTE
// Uma janela oculta que fica sempre aberta para não termos o overhead de criação a cada ticket
function createPersistentSpooler() {
    persistentSpoolerWindow = new BrowserWindow({
        show: false,
        width: 400,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            // Offscreen: não compõe na GPU, reduz uso de VRAM/CPU quando idle.
            offscreen: true,
            // Throttling: timers/animations pausam quando a janela está oculta (que é sempre).
            backgroundThrottling: true,
            preload: path.join(__dirname, 'preloadSpooler.js')
        }
    });
    // Reduz FPS do compositor offscreen ao mínimo — só precisamos do frame pra imprimir
    try { persistentSpoolerWindow.webContents.setFrameRate(1); } catch { /* electron < 12 */ }
    persistentSpoolerWindow.loadFile(path.join(__dirname, 'public/blank-spooler.html'));
    
    // Configura o handler de retorno do print (quando a página avisa que renderizou)
    ipcMain.on('spooler-ready-to-print', (event, { id, printerName, widthMicrons }) => {
        if (!persistentSpoolerWindow) return;

        // Defesa em profundidade: o agent.js já valida antes do IPC, mas
        // nunca queremos chegar a `webContents.print` com deviceName vazio —
        // o Electron cairia na impressora padrão do Windows.
        if (!isValidPrinterName(printerName)) {
            if (agentProcess) {
                agentProcess.send({
                    type: 'PRINT_HTML_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido no spooler — impressão abortada (não usar default printer).',
                });
            }
            return;
        }

        persistentSpoolerWindow.webContents.print({
            deviceName: printerName,
            silent: true,
            printBackground: true,
            pageSize: { width: widthMicrons, height: 297000 },
            margins: { marginType: 'none' }
        }, (success, failureReason) => {
            // Avisa de volta ao processo agent.js
            if (agentProcess) {
                if (success) {
                    agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: true });
                } else {
                    agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: false, error: failureReason || 'Falha na impressão pelo Spooler' });
                }
            }
        });
    });
}

// 1. INICIA O MOTOR (AGENT.JS)
function startAgent() {
    // Pass ELECTRON_RUN env var to disable internal clustering in agent.js
    agentProcess = fork(path.join(__dirname, 'agent.js'), [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
            ...process.env,
            ELECTRON_RUN: 'true',
            USER_DATA_PATH: app.getPath('userData'),
            RESOURCES_PATH: process.resourcesPath
        }
    });

    agentProcess.on('message', (msg) => {
        if (msg.type === 'UPDATE_DATA') {
            // Recebe dados do backend e atualiza a interface
            agentState = msg.payload;
            updateTrayMenu();
        } else if (msg.type === 'NOTIFICATION') {
            showNotification(msg);
        } else if (msg.type === 'UPDATE_ACTION') {
            // Ação vinda dos endpoints REST do agent (POST /api/update/*).
            // requestId permite ao agent.js correlacionar a resposta.
            const { requestId, action, version } = msg;
            const respond = (result) => {
                try { agentProcess.send({ type: 'UPDATE_ACTION_RESULT', requestId, ...result }); } catch { /* ignore */ }
            };
            try {
                if (action === 'check') {
                    Promise.resolve(actionCheckForUpdates()).then(respond);
                } else if (action === 'download') {
                    Promise.resolve(actionStartDownload()).then(respond);
                } else if (action === 'install') {
                    respond(actionInstallNow());
                } else if (action === 'skip') {
                    respond(actionSkipVersion(version));
                } else if (action === 'status') {
                    respond({ ok: true, state: {
                        status: updateState.status,
                        version: updateState.info && updateState.info.version,
                        releaseNotes: updateState.info && (updateState.info.releaseNotes || ''),
                        releaseName: updateState.info && (updateState.info.releaseName || ''),
                        releaseDate: updateState.info && (updateState.info.releaseDate || null),
                        currentVersion: updateState.currentVersion,
                        error: updateState.error,
                        progress: updateState.downloadProgress,
                        skippedVersions: updateState.skippedVersions,
                        lastCheckedAt: updateState.lastCheckedAt,
                    }});
                } else {
                    respond({ ok: false, error: 'Ação desconhecida: ' + action });
                }
            } catch (e) {
                respond({ ok: false, error: e && e.message });
            }
        } else if (msg.type === 'ENCRYPT') {
            // 🔒 SafeStorage Bridge (Main Process -> Worker)
            const { id, data } = msg;
            try {
                if (app.isReady() && safeStorage.isEncryptionAvailable()) {
                    const encrypted = safeStorage.encryptString(data);
                    // Retorna como hex para ser JSON-safe
                    agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: true, data: encrypted.toString('hex') });
                } else {
                    agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: false, error: 'Encryption unavailable' });
                }
            } catch (e) {
                agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: false, error: e.message });
            }
        } else if (msg.type === 'DECRYPT') {
            // 🔓 SafeStorage Bridge
            const { id, dataHex } = msg;
            try {
                if (app.isReady() && safeStorage.isEncryptionAvailable()) {
                    const buffer = Buffer.from(dataHex, 'hex');
                    const decrypted = safeStorage.decryptString(buffer);
                    agentProcess.send({ type: 'DECRYPT_RESULT', id, success: true, data: decrypted });
                } else {
                    agentProcess.send({ type: 'DECRYPT_RESULT', id, success: false, error: 'Encryption unavailable' });
                }
            } catch (e) {
                // Erro comum: chave mudou ou arquivo corrompido
                agentProcess.send({ type: 'DECRYPT_RESULT', id, success: false, error: e.message });
            }
        } else if (msg.type === 'PRINT_TEST_LABEL') {
            // 🖨️ Imprime etiqueta de teste diretamente via Electron webContents.print()
            const { id, company, printerName } = msg;

            // Defesa em profundidade: rejeita antes de criar BrowserWindow.
            if (!isValidPrinterName(printerName)) {
                agentProcess.send({
                    type: 'PRINT_TEST_LABEL_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido — teste de impressão abortado.',
                });
                return;
            }

            const labelWin = new BrowserWindow({
                width: 380,   // Largura suficiente para 80mm (302px) + margem do SO
                height: 800,  // Altura longa para não cortar o final do recibo
                show: false,
                webPreferences: { nodeIntegration: false }
            });

            const staticPath = path.join(__dirname, 'public');
            const encodedCompany = encodeURIComponent(company || '');
            labelWin.loadFile(path.join(staticPath, 'test-label.html'), {
                query: { company: encodedCompany }
            });

            labelWin.webContents.once('did-finish-load', async () => {
                // Aguarda 400ms para os scripts da página terminarem
                await new Promise(r => setTimeout(r, 400));

                labelWin.webContents.print({
                    deviceName: printerName,
                    silent: true,
                    printBackground: true,
                    // Epson i9 Full: Papel 80mm = ~79500 a 80000 microns. 
                    // Altura a gente deixa longa (297000) e a impressora térmica faz auto-cut no fim da página 
                    pageSize: { width: 80000, height: 297000 },
                    margins: { marginType: 'none' }
                }, (success, failureReason) => {
                    labelWin.destroy();
                    if (success) {
                        agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: true });
                    } else {
                        agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: false, error: failureReason || 'Falha na impressão' });
                    }
                });
            });

            labelWin.webContents.on('did-fail-load', (event, code, desc) => {
                agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: false, error: desc });
                labelWin.destroy();
            });

        } else if (msg.type === 'PRINT_HTML') {
            // 🖨️ Pipeline Otimizado v2: Envia para o Spooler Persistente (Sem disco, sem delay engessado)
            const { id, htmlContent, printerName } = msg;

            // Defesa em profundidade: nunca encaminhar nome inválido para o spooler.
            if (!isValidPrinterName(printerName)) {
                agentProcess.send({
                    type: 'PRINT_HTML_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido — impressão HTML abortada (não usar default printer).',
                });
                return;
            }

            if (!persistentSpoolerWindow || persistentSpoolerWindow.isDestroyed()) {
                createPersistentSpooler();
            }

            try {
                // Parse a largura exigida pelo layout
                const match = (htmlContent || "").match(/@page\s*\{[^}]*size:\s*([0-9.]+)\s*mm/i);
                const widthMm = match ? parseFloat(match[1]) : 72;
                const widthMicrons = Math.round((Number.isFinite(widthMm) ? widthMm : 72) * 1000);

                // Dispara mensagem IPC para a janela renderizar o conteúdo via Preload Script
                persistentSpoolerWindow.webContents.send('inject-html-for-print', {
                    id,
                    htmlContent,
                    printerName,
                    widthMicrons
                });
            } catch (e) {
                agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: false, error: 'Erro no pipeline persistente: ' + e.message });
            }
        }
    });

    // Debug no terminal
    agentProcess.stdout.on('data', d => console.log(`[AGENT]: ${d}`));
    agentProcess.stderr.on('data', d => console.error(`[AGENT ERROR]: ${d}`));
}

// 2. NOTIFICAÇÕES TIPO "TOAST"
function showNotification({ title, body, urgency }) {
    const notification = new Notification({
        title: title,
        body: body,
        icon: path.join(__dirname, 'public/icon.png'),
        urgency: urgency || 'normal'
    });

    notification.on('click', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    notification.show();
}

// 3. JANELA PRINCIPAL (DASHBOARD)
function createWindow(shouldShow = false) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false, // Começa sempre false para evitar "brilho" branco antes de carregar
        icon: path.join(__dirname, 'public/icon.png'),
        backgroundColor: '#09090B', // Coincide com var(--bg-main) do CSS
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false }
    });

    // Polling para aguardar o servidor subir (Evita tela branca/preta)
    const checkServer = async (attempt = 1) => {
        const { net } = require('electron');
        const request = net.request('http://127.0.0.1:9876/login.html');

        request.on('response', (response) => {
            if (response.statusCode === 200) {
                mainWindow.loadURL('http://127.0.0.1:9876');
                if (shouldShow) {
                    mainWindow.once('ready-to-show', () => {
                        mainWindow.show();
                        mainWindow.focus();
                    });
                    // Fallback visual
                    setTimeout(() => {
                        if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
                    }, 1000);
                }
            } else {
                // Servidor respondeu erro, tenta de novo?
                if (attempt < 10) setTimeout(() => checkServer(attempt + 1), 500);
            }
        });

        request.on('error', (error) => {
            if (attempt < 20) { // Tenta por 10 segundos (20 * 500ms)
                setTimeout(() => checkServer(attempt + 1), 500);
            } else {
                console.error('SERVER', 'Timeout aguardando servidor Express.');
            }
        });

        request.end();
    };

    // Inicia o polling após 1s (dar tempo pro fork)
    setTimeout(checkServer, 1000);

    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide(); // Minimiza para bandeja em vez de fechar
        }
        return false;
    });
}

// 4. MENU DA BANDEJA (ESTILO iCUE)
function createTray() {
    let trayIcon;

    if (process.platform === 'win32') {
        const icoPath = path.join(__dirname, 'public/icon.ico');
        trayIcon = nativeImage.createFromPath(icoPath);
    } else {
        trayIcon = getIcon('tray-icon.png') || getIcon('icon.png');
    }

    if (!trayIcon || trayIcon.isEmpty()) {
        const iconPng = path.join(__dirname, 'public/icon.png');
        trayIcon = nativeImage.createFromPath(iconPng).resize({ width: 16, height: 16 });
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('OnTrack Agent - Protegido');
    tray.on('double-click', () => mainWindow.show());
    updateTrayMenu();
}

function getIcon(name) {
    try {
        const p = path.join(__dirname, 'public', name);
        return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    } catch (e) { return null; }
}

function updateTrayMenu() {
    if (!tray) return;

    const themeSuffix = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';

    const sysStatus = (agentState.status || '').toUpperCase();
    const prnStatus = (agentState.printerStatus || '').toUpperCase();
    const prnName = (agentState.printerName || '');

    let sysIcon = 'status-off.png';
    if (sysStatus.includes('INICIANDO') || sysStatus.includes('CONNECTING') || sysStatus === '...') {
        sysIcon = `wait-${themeSuffix}.png`;
    } else if (sysStatus === 'ONLINE' || sysStatus === 'SUBSCRIBED' || sysStatus === 'CONNECTED') {
        sysIcon = 'status-on.png';
    }

    let prnIcon = 'status-off.png';
    if (prnStatus === '...' || prnStatus === 'DETECTANDO...' || prnName === 'Detectando...') {
        prnIcon = `wait-${themeSuffix}.png`;
    } else if (prnStatus === 'PRONTA' || prnStatus === 'ONLINE' || prnStatus === 'IDLE') {
        prnIcon = 'status-on.png';
    }

    const overallStatus = (sysIcon === 'status-on.png' && prnIcon === 'status-on.png') ? 'Operacional' : 'Aguardando/Atenção';
    tray.setToolTip(`OnTrack Agent: ${overallStatus}\nSistema: ${agentState.status}\nImpressora: ${agentState.printerStatus}`);

    // ── Itens de update dinâmicos ───────────────────────────────────────
    // Política: SEMPRE expor "Verificar atualizações" + a versão atual,
    // mesmo quando não há nada novo. Quando há, mostra ações contextuais
    // antes do item permanente.
    const updateMenuItems = [];
    if (updateState.status === 'available' && updateState.info) {
        updateMenuItems.push({
            label: `🆕 Nova versão ${updateState.info.version} disponível`,
            enabled: false,
        });
        updateMenuItems.push({
            label: '⬇️ Baixar agora',
            click: () => { actionStartDownload(); },
        });
        updateMenuItems.push({
            label: '⏭️ Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateMenuItems.push({ type: 'separator' });
    } else if (updateState.status === 'downloading' && updateState.info) {
        updateMenuItems.push({
            label: `⬇️ Baixando ${updateState.info.version}... (${updateState.downloadProgress}%)`,
            enabled: false,
        });
        updateMenuItems.push({ type: 'separator' });
    } else if (updateState.status === 'ready' && updateState.info) {
        updateMenuItems.push({
            label: `✅ ${updateState.info.version} pronta para instalar`,
            enabled: false,
        });
        updateMenuItems.push({
            label: '🔄 Instalar e reiniciar agora',
            click: () => { actionInstallNow(); },
        });
        updateMenuItems.push({
            label: '⏭️ Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateMenuItems.push({ type: 'separator' });
    } else if (updateState.status === 'error') {
        updateMenuItems.push({
            label: `⚠️ Erro: ${(updateState.error || 'desconhecido').slice(0, 50)}`,
            enabled: false,
        });
        updateMenuItems.push({ type: 'separator' });
    } else if (updateState.status === 'skipped' && updateState.info) {
        updateMenuItems.push({
            label: `⏭️ ${updateState.info.version} pulada`,
            enabled: false,
        });
        updateMenuItems.push({ type: 'separator' });
    }
    // Item PERMANENTE — mostra versão e permite verificação manual.
    updateMenuItems.push({
        label: `OnTrack Agent v${updateState.currentVersion}`,
        enabled: false,
    });
    updateMenuItems.push({
        label: updateState.status === 'checking' ? 'Verificando...' : '🔄 Verificar atualizações',
        enabled: app.isPackaged && updateState.status !== 'checking' && updateState.status !== 'downloading',
        click: () => { actionCheckForUpdates(); },
    });
    updateMenuItems.push({ type: 'separator' });

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'OnTrack Agent',
            icon: getIcon('icon.png'),
            enabled: false
        },
        { type: 'separator' },
        ...updateMenuItems,
        {
            label: `Sistema: ${agentState.status}`,
            icon: getIcon(sysIcon),
            enabled: false
        },
        {
            label: `Impressora: ${agentState.printerName}`,
            icon: getIcon(prnIcon),
            enabled: false
        },
        {
            label: `Status: ${agentState.printerStatus}`,
            icon: getIcon(prnIcon),
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Corrigir Fila de Impressão',
            icon: getIcon(`action-clean-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'FORCE_CLEAR_QUEUE' });
                tray.displayBalloon({ title: 'Manutenção', content: 'Limpando spooler...' });
            }
        },
        {
            label: 'Teste de Impressão',
            icon: getIcon(`printer-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'RUN_TEST_PRINT' });
            }
        },
        {
            label: 'Abrir Painel de Controle',
            icon: getIcon(`action-settings-${themeSuffix}.png`),
            click: () => mainWindow.show()
        },
        { type: 'separator' },
        {
            label: 'Sair / Encerrar',
            icon: getIcon(`action-exit-${themeSuffix}.png`),
            click: () => {
                app.isQuitting = true;
                if (agentProcess) agentProcess.kill();
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
}

app.on('before-quit', () => {
    if (agentProcess) agentProcess.kill();
});
