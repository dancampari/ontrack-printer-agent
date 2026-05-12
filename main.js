const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, nativeTheme, safeStorage, screen } = require('electron');
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
    autoInstallAfterDownload: false, // se true, instala automaticamente ao terminar o download
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

function actionStartDownload(options = {}) {
    if (!app.isPackaged) return Promise.resolve({ ok: false, error: 'Não disponível em modo dev.' });
    if (!updateState.info) return Promise.resolve({ ok: false, error: 'Nenhuma atualização disponível.' });
    const autoInstall = !!options.autoInstall;

    if (updateState.status === 'downloading') {
        // Permitir promover um download em andamento para auto-install (caso usuário
        // tenha clicado primeiro em "só baixar" e depois mudou de ideia).
        if (autoInstall) updateState.autoInstallAfterDownload = true;
        return Promise.resolve({ ok: false, error: 'Download já em andamento.' });
    }
    if (updateState.status === 'ready') {
        // Já baixado — se autoInstall, instala direto.
        if (autoInstall) return Promise.resolve(actionInstallNow());
        return Promise.resolve({ ok: true, alreadyReady: true });
    }

    updateState.status = 'downloading';
    updateState.downloadProgress = 0;
    updateState.autoInstallAfterDownload = autoInstall;
    pushUpdateStateToAgent();
    updateTrayMenu();

    return autoUpdater.downloadUpdate()
        .then(() => ({ ok: true, autoInstall }))
        .catch((err) => {
            updateState.status = 'error';
            updateState.error = err && err.message;
            updateState.autoInstallAfterDownload = false;
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
        createTrayPopup();         // Pré-cria popup (oculto) para clique instantâneo
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
    pushUpdateStateToAgent();
    updateTrayMenu();

    // Se o usuário escolheu "Baixar e instalar", aplica direto sem segundo clique.
    if (updateState.autoInstallAfterDownload) {
        updateState.autoInstallAfterDownload = false; // consome a flag para não repetir
        showNotification({
            title: 'Instalando atualização',
            body: `${info.version} pronta. O agent será reiniciado em instantes.`,
        });
        // Pequeno delay (1.5s) para o modal mostrar "100% — Pronta" antes do quit
        setTimeout(() => {
            const r = actionInstallNow();
            if (!r.ok) console.warn('[autoUpdater] auto-install falhou:', r.error);
        }, 1500);
    } else {
        showNotification({
            title: 'Atualização pronta',
            body: `${info.version} baixada. Clique em "Instalar agora" no painel quando preferir.`,
        });
    }
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

// Escuta mudanças de tema do SO para atualizar ícones do menu nativo (fallback)
// E re-empurra o state pro popup HTML (claro ↔ escuro segue o Windows ao vivo).
nativeTheme.on('updated', () => {
    updateTrayMenu();
    pushTrayState();
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
                    Promise.resolve(actionStartDownload({ autoInstall: !!msg.autoInstall })).then(respond);
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

    // Substitui o menu nativo padrão por um popup HTML com realtime.
    // Esquerdo, direito e duplo-clique abrem o popup (UX unificada).
    // Em caso de falha do popup, showTrayPopup cai automaticamente para o
    // menu nativo construído por updateTrayMenu (fallback).
    tray.on('click', () => showTrayPopup());
    tray.on('right-click', () => showTrayPopup());
    tray.on('double-click', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    updateTrayMenu(); // popula lastNativeMenu (fallback) e tooltip
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

    // Usa includes() porque os valores reais são strings compostas:
    //  sysStatus pode ser "SUBSCRIBED", "CONNECTING", "ONLINE", "DISCONNECTED"...
    //  prnStatus vem do state.printerStatus.message: "Online e Pronta",
    //    "Imprimindo...", "Offline (Pausada/Cabo)", "Aguardando", "Não encontrada".
    let sysIcon = 'status-off.png';
    if (sysStatus.includes('INICIANDO') || sysStatus.includes('CONNECTING') || sysStatus === '...') {
        sysIcon = `wait-${themeSuffix}.png`;
    } else if (sysStatus.includes('ONLINE') || sysStatus.includes('SUBSCRIBED') || sysStatus.includes('CONNECTED')) {
        sysIcon = 'status-on.png';
    }

    let prnIcon = 'status-off.png';
    if (prnStatus === '...' || prnStatus.includes('DETECTANDO') || prnStatus.includes('AGUARDANDO') || prnName === 'Detectando...') {
        prnIcon = `wait-${themeSuffix}.png`;
    } else if (
        prnStatus.includes('ONLINE') ||
        prnStatus.includes('PRONTA') ||
        prnStatus.includes('IMPRIMINDO') ||
        prnStatus.includes('IDLE')
    ) {
        prnIcon = 'status-on.png';
    }

    const overallStatus = (sysIcon === 'status-on.png' && prnIcon === 'status-on.png') ? 'Operacional' : 'Aguardando/Atenção';
    tray.setToolTip(`OnTrack Agent: ${overallStatus}\nSistema: ${agentState.status}\nImpressora: ${agentState.printerStatus}`);

    // ── Itens de update contextuais ─────────────────────────────────────
    // Mostrados apenas quando há ação útil. Sem emojis — só texto limpo.
    // "Verificar atualizações" fica na seção de ações abaixo, sempre acessível.
    const updateContextItems = [];
    if (updateState.status === 'available' && updateState.info) {
        updateContextItems.push({
            label: `Atualização disponível: v${updateState.info.version}`,
            enabled: false,
        });
        updateContextItems.push({
            label: 'Baixar e instalar',
            click: () => { actionStartDownload({ autoInstall: true }); },
        });
        updateContextItems.push({
            label: 'Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateContextItems.push({ type: 'separator' });
    } else if (updateState.status === 'downloading' && updateState.info) {
        const willInstall = updateState.autoInstallAfterDownload ? ' (instala ao terminar)' : '';
        updateContextItems.push({
            label: `Baixando v${updateState.info.version} (${updateState.downloadProgress}%)${willInstall}`,
            enabled: false,
        });
        updateContextItems.push({ type: 'separator' });
    } else if (updateState.status === 'ready' && updateState.info) {
        updateContextItems.push({
            label: `Versão v${updateState.info.version} pronta para instalar`,
            enabled: false,
        });
        updateContextItems.push({
            label: 'Instalar e reiniciar agora',
            click: () => { actionInstallNow(); },
        });
        updateContextItems.push({
            label: 'Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateContextItems.push({ type: 'separator' });
    }

    const checkLabel =
        updateState.status === 'checking' ? 'Verificando atualizações...' :
        updateState.status === 'downloading' ? 'Aguarde o download...' :
        'Verificar atualizações';
    const checkEnabled = app.isPackaged
        && updateState.status !== 'checking'
        && updateState.status !== 'downloading';

    // O menu nativo é mantido como FALLBACK: usado se o popup HTML falhar.
    // No caminho feliz, o usuário vê o popup HTML (realtime). Em qualquer
    // erro de criação/posicionamento do popup, cai pra esse menu via
    // tray.popUpContextMenu(buildNativeMenu()).
    const contextMenu = Menu.buildFromTemplate([
        {
            label: `OnTrack Agent v${updateState.currentVersion}`,
            icon: getIcon('icon.png'),
            enabled: false,
        },
        { type: 'separator' },
        ...updateContextItems,
        {
            label: `Sistema: ${agentState.status}`,
            icon: getIcon(sysIcon),
            enabled: false,
        },
        {
            label: `Impressora: ${agentState.printerName}`,
            icon: getIcon(prnIcon),
            enabled: false,
        },
        {
            label: `Status: ${agentState.printerStatus}`,
            icon: getIcon(prnIcon),
            enabled: false,
        },
        { type: 'separator' },
        {
            label: checkLabel,
            icon: getIcon(`refresh-ccw-dot-${themeSuffix}.png`),
            enabled: checkEnabled,
            click: () => { actionCheckForUpdates(); },
        },
        {
            label: 'Corrigir Fila de Impressão',
            icon: getIcon(`action-clean-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'FORCE_CLEAR_QUEUE' });
                tray.displayBalloon({ title: 'Manutenção', content: 'Limpando spooler...' });
            },
        },
        {
            label: 'Imprimir Página de Teste',
            icon: getIcon(`printer-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'RUN_TEST_PRINT' });
            },
        },
        {
            label: 'Abrir Painel de Controle',
            icon: getIcon(`action-settings-${themeSuffix}.png`),
            click: () => mainWindow.show(),
        },
        { type: 'separator' },
        {
            label: 'Sair',
            icon: getIcon(`action-exit-${themeSuffix}.png`),
            click: () => {
                app.isQuitting = true;
                if (agentProcess) agentProcess.kill();
                app.quit();
            },
        },
    ]);

    // Cacheia o menu para uso como FALLBACK se o popup HTML falhar.
    // NÃO chamamos tray.setContextMenu(contextMenu) — assim o clique padrão
    // não abre o menu nativo automaticamente; quem comanda é o tray.on('click').
    lastNativeMenu = contextMenu;

    // Push do estado pro popup HTML (se estiver aberto, atualiza em realtime).
    pushTrayState();
}

// ── Tray Popup HTML (substitui menu nativo, mantém fallback) ────────────────
let lastNativeMenu = null;
let trayPopupWindow = null;
let trayPopupHideTimer = null;
const TRAY_POPUP_WIDTH = 300;
const TRAY_POPUP_HEIGHT = 540;

function createTrayPopup() {
    // Padrão consagrado de "tray window" em Electron (Slack, Docker, Rocket.Chat):
    //  - transparent + frame:false + alwaysOnTop
    //  - useContentSize evita off-by-one em escala 125%/150% do Windows
    //  - paintWhenInitiallyHidden força paint do conteúdo durante show:false
    //    (evita flash branco no primeiro click)
    //  - backgroundThrottling:false mantém o compositor ativo enquanto oculto
    trayPopupWindow = new BrowserWindow({
        width: TRAY_POPUP_WIDTH,
        height: TRAY_POPUP_HEIGHT,
        useContentSize: true,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        focusable: true,
        paintWhenInitiallyHidden: true,
        hasShadow: false, // sombra própria via CSS (transparente sem artefatos)
        webPreferences: {
            preload: path.join(__dirname, 'preloadTray.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false,
        },
    });
    trayPopupWindow.setMenu(null);
    trayPopupWindow.loadFile(path.join(__dirname, 'public', 'tray-popup.html'));

    // "Warm-up dance": mostra invisível por 1 frame para preparar o compositor
    // do Windows. Sem isso, o primeiro show pisca branco. Padrão usado por
    // várias libs de tray-window (electron-tray-window, menubar, etc).
    trayPopupWindow.once('ready-to-show', () => {
        try {
            trayPopupWindow.setOpacity(0);
            trayPopupWindow.showInactive();
            setTimeout(() => {
                if (trayPopupWindow && !trayPopupWindow.isDestroyed()) {
                    trayPopupWindow.hide();
                    trayPopupWindow.setOpacity(1);
                }
            }, 50);
        } catch { /* ignore */ }
    });

    // Fecha ao perder foco (clique fora). Debounce de 120ms evita race em
    // cliques rápidos que disparam blur antes do hide intencional.
    trayPopupWindow.on('blur', () => {
        if (trayPopupHideTimer) clearTimeout(trayPopupHideTimer);
        trayPopupHideTimer = setTimeout(() => {
            if (trayPopupWindow && !trayPopupWindow.isDestroyed()) trayPopupWindow.hide();
        }, 120);
    });
    trayPopupWindow.on('show', () => {
        if (trayPopupHideTimer) { clearTimeout(trayPopupHideTimer); trayPopupHideTimer = null; }
    });
}

function positionTrayPopup() {
    if (!trayPopupWindow || trayPopupWindow.isDestroyed()) return;

    // Algoritmo dos 4 quadrantes (mesma estratégia de electron-tray-window,
    // menubar, Rocket.Chat). Determina onde o tray icon está e abre o popup
    // "para dentro" da tela.
    //
    // tray.getBounds() pode retornar zeros se o ícone está no overflow
    // (atrás da seta `^` do Windows). Fallback: cursor no momento do click.
    let trayBounds = tray ? tray.getBounds() : null;
    const cursor = screen.getCursorScreenPoint();
    const trayBoundsInvalid = !trayBounds || (!trayBounds.width && !trayBounds.height);
    if (trayBoundsInvalid) {
        trayBounds = { x: cursor.x - 8, y: cursor.y - 8, width: 16, height: 16 };
    }

    // Pega o display em que o tray icon (ou cursor) está
    const refPoint = { x: trayBounds.x, y: trayBounds.y, width: 1, height: 1 };
    const display = screen.getDisplayMatching(refPoint);
    const screenSize = display.workAreaSize;
    const screenOrigin = display.workArea;

    // Posição relativa ao display
    const relX = trayBounds.x - screenOrigin.x;
    const relY = trayBounds.y - screenOrigin.y;

    // Quadrante: 1=top-left, 2=top-right, 3=bottom-left, 4=bottom-right
    let quad = 4;
    quad = (relY > screenSize.height / 2) ? quad : quad / 2;
    quad = (relX > screenSize.width / 2)  ? quad : quad - 1;

    const w = TRAY_POPUP_WIDTH;
    const h = TRAY_POPUP_HEIGHT;
    let x = 0, y = 0;

    switch (quad) {
        case 1: // top-left  (taskbar superior/esquerda)
            x = Math.floor(trayBounds.x + trayBounds.width / 2);
            y = Math.floor(trayBounds.y + trayBounds.height + 4);
            break;
        case 2: // top-right (taskbar superior, ícone à direita)
            x = Math.floor(trayBounds.x - w + trayBounds.width / 2);
            y = Math.floor(trayBounds.y + trayBounds.height + 4);
            break;
        case 3: // bottom-left (taskbar inferior/esquerda)
            x = Math.floor(trayBounds.x + trayBounds.width / 2);
            y = Math.floor(trayBounds.y - h - 4);
            break;
        case 4: // bottom-right (CASO MAIS COMUM: taskbar inferior, ícone à direita)
        default:
            x = Math.floor(trayBounds.x - w + trayBounds.width / 2);
            y = Math.floor(trayBounds.y - h - 4);
            break;
    }

    // Clamp final pra garantir que está totalmente dentro do display
    x = Math.max(screenOrigin.x + 8, Math.min(screenOrigin.x + screenSize.width - w - 8, x));
    y = Math.max(screenOrigin.y + 8, Math.min(screenOrigin.y + screenSize.height - h - 8, y));

    trayPopupWindow.setBounds({ x, y, width: w, height: h });
}

function showTrayPopup() {
    try {
        if (!trayPopupWindow || trayPopupWindow.isDestroyed()) createTrayPopup();
        if (trayPopupWindow.isVisible()) {
            trayPopupWindow.hide();
            return;
        }
        // Ordem importa: setBounds ANTES de show evita o "flash" do popup
        // aparecer na posição antiga e pular para a nova.
        positionTrayPopup();
        // showInactive + focus separados → mais estável que show() puro no Windows.
        trayPopupWindow.showInactive();
        trayPopupWindow.focus();
        pushTrayState();
    } catch (e) {
        // Fallback: se algo na BrowserWindow falhar, usa o menu nativo do Windows.
        console.warn('[tray] popup falhou, fallback nativo:', e && e.message);
        try {
            if (lastNativeMenu && tray) tray.popUpContextMenu(lastNativeMenu);
        } catch { /* ignore */ }
    }
}

function hideTrayPopup() {
    if (trayPopupWindow && !trayPopupWindow.isDestroyed()) trayPopupWindow.hide();
}

function pushTrayState() {
    if (!trayPopupWindow || trayPopupWindow.isDestroyed()) return;
    try {
        trayPopupWindow.webContents.send('tray:state', {
            // Fonte autoritativa do tema = Electron nativeTheme (segue o Windows
            // automaticamente). Popup aplica .dark no <html> conforme.
            theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
            agent: agentState,
            update: {
                status: updateState.status,
                version: updateState.info && updateState.info.version,
                currentVersion: updateState.currentVersion,
                progress: updateState.downloadProgress,
                error: updateState.error,
                autoInstall: !!updateState.autoInstallAfterDownload,
                canCheck: app.isPackaged
                    && updateState.status !== 'checking'
                    && updateState.status !== 'downloading',
            },
        });
    } catch { /* ignore */ }
}

// IPC do popup → main: roteia para as funções existentes.
ipcMain.on('tray:action', (_evt, msg) => {
    const action = msg && msg.action;
    const payload = msg && msg.payload;
    switch (action) {
        case 'request-state':
            pushTrayState();
            break;
        case 'check-updates':
            actionCheckForUpdates();
            break;
        case 'update-download-and-install':
            actionStartDownload({ autoInstall: true });
            break;
        case 'update-install':
            actionInstallNow();
            break;
        case 'update-skip':
            actionSkipVersion(payload && payload.version);
            hideTrayPopup();
            break;
        case 'fix-queue':
            if (agentProcess) agentProcess.send({ type: 'FORCE_CLEAR_QUEUE' });
            if (tray) tray.displayBalloon({ title: 'Manutenção', content: 'Limpando spooler...' });
            hideTrayPopup();
            break;
        case 'test-print':
            if (agentProcess) agentProcess.send({ type: 'RUN_TEST_PRINT' });
            hideTrayPopup();
            break;
        case 'open-dashboard':
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
            hideTrayPopup();
            break;
        case 'quit':
            app.isQuitting = true;
            if (agentProcess) agentProcess.kill();
            app.quit();
            break;
        case 'close':
            hideTrayPopup();
            break;
    }
});

app.on('before-quit', () => {
    if (agentProcess) agentProcess.kill();
});
