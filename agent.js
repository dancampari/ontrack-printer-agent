const auth = require('./src/core/auth');
const database = require('./src/core/database');
const socket = require('./src/core/socket');
const server = require('./src/api/server');
const logger = require('./src/utils/logger');
const state = require('./src/config/state');
const pshost = require('./src/core/pshost');
const { safePrinterName, isValidPrinterName } = require('./src/utils/printerValidator');

// Services
const printerUSB = require('./src/services/printerUSB');
const printerNetwork = require('./src/services/printerNetwork');
const printerPDF = require('./src/services/printerPDF');
const monitor = require('./src/services/monitor');

// Carrega o helper RawPrinterHelper uma única vez na vida do PowerShell persistente.
pshost.setPreamble(printerUSB.PREAMBLE);
pshost.start();

// IPC for Desktop Integration (Tray Update)
const ipc = require('process');
const { EventEmitter } = require('events');

// Polyfill WebSocket (Crítico para Supabase em Node/Electron backend)
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// Emissor interno: processJob emite `done:<id>` quando termina (sucesso/falha).
// Quem precisa aguardar o término de um job específico (ex.: controller do
// /api/local-print, que mantém o contrato HTTP síncrono) assina aqui.
const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(100);
global.jobEmitter = jobEmitter;

// Bridge IPC para ações do autoUpdater. main.js detém o autoUpdater (Electron API).
// Os endpoints REST do controller (POST /api/update/*) precisam acionar essas
// ações sem ter acesso direto ao Electron — usam essa ponte.
const updateActionWaiters = new Map(); // requestId → { resolve, reject, timer }

function requestUpdateAction(action, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível (modo standalone)'));
        const requestId = `upd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            updateActionWaiters.delete(requestId);
            reject(new Error(`Timeout aguardando ação de update: ${action}`));
        }, timeoutMs);
        updateActionWaiters.set(requestId, { resolve, reject, timer });
        ipc.send({ type: 'UPDATE_ACTION', requestId, action, ...params });
    });
}
global.requestUpdateAction = requestUpdateAction;

// Mapa de promises pendentes para geração de PDF via IPC
const pendingPdfRequests = new Map();

/**
 * Solicita ao Electron (main.js) que imprima a etiqueta de teste diretamente via webContents.print().
 */
function requestTestPrint(company, printerName) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível (modo standalone)'));
        // Defesa: nunca encaminhar deviceName vazio para o Electron (cairia na
        // impressora padrão do Windows — pode ser de outro setor).
        if (!isValidPrinterName(printerName)) {
            return reject(new Error('Nome da impressora inválido para teste — rejeitado para não usar default printer do sistema.'));
        }
        const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        pendingPdfRequests.set(id, { resolve, reject });
        ipc.send({ type: 'PRINT_TEST_LABEL', id, company, printerName });

        setTimeout(() => {
            if (pendingPdfRequests.has(id)) {
                pendingPdfRequests.delete(id);
                reject(new Error('Timeout ao imprimir etiqueta de teste'));
            }
        }, 15000);
    });
}

/**
 * Direct Local Print: Envia o HTML recebido pelo servidor local diretamente para a impressora.
 */
function requestHtmlPrint(id, htmlContent, printerName) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível'));
        if (!isValidPrinterName(printerName)) {
            return reject(new Error('Nome da impressora inválido — rejeitado para não usar default printer do sistema.'));
        }
        pendingPdfRequests.set(id, { resolve, reject });
        ipc.send({ type: 'PRINT_HTML', id, htmlContent, printerName });

        setTimeout(() => {
            if (pendingPdfRequests.has(id)) {
                pendingPdfRequests.delete(id);
                reject(new Error('Timeout ao imprimir HTML local'));
            }
        }, 20000);
    });
}

// Expõe para uso nos controllers
global.requestTestPrint = requestTestPrint;
global.requestHtmlPrint = requestHtmlPrint;

async function bootstrap() {
    logger.init();
    logger.info('MAIN', '=== ONTRACK AGENT v3.9.5 (Modal: tipografia compacta + hierarquia visual CTA/ghost/link) ===');

    // 1. Inicializa Autenticação (Tenta carregar sessão do disco)
    const isAuthenticated = await auth.init();

    // 2. Configura Anti-Collision Module (Fila Local Sequencial)
    const jobQueue = [];
    const processedJobIds = new Set(); // Evita duplicidade (Realtime vs Polling)
    let isProcessingQueue = false;

    const processJob = async (job) => {
        const { id, zpl_content, job_type, file_path, printer_name, source } = job;
        // Jobs locais (single ou batch) NÃO existem na tabela print_queue do banco.
        // Pular `updateJobStatus` evita round-trips inúteis para registros inexistentes.
        const isLocalJob = source === 'local-batch' || source === 'local-single';
        logger.info('JOB', `Processando Job ${id} (${job_type}${isLocalJob ? ', ' + source : ''})...`);

        // Stats CENTRALIZADAS aqui — qualquer job que passe pelo processJob conta,
        // independente do branch (pdf / html / usb-raw / network). Antes o
        // incremento estava espalhado nos services e o caminho HTML não contava.
        state.stats.totalJobs++;

        try {
            // Jobs vindos do POST /api/local-print-batch NÃO existem no banco —
            // não faz sentido tentar UPDATE em print_queue (no-op + round-trip à toa).
            if (!isLocalJob) {
                await database.updateJobStatus(id, 'processing');
            }
            // Revalida status da impressora antes de imprimir (substitui o polling de 5s)
            monitor.onDeviceChange('pre-print').catch(() => {});

            if (job_type === 'pdf') {
                const pName = safePrinterName(state.currentConfig.printerName, printer_name);
                if (!pName) throw new Error('Impressora não configurada — job PDF rejeitado para não usar default printer.');
                await printerPDF.print(id, pName, file_path);
            } else if (job_type === 'html') {
                const pName = safePrinterName(state.currentConfig.printerName, printer_name);
                if (!pName) throw new Error('Impressora não configurada — job HTML rejeitado para não usar default printer.');
                // Render HTML string using Electron BrowserWindow in the Main Process
                await new Promise((resolve, reject) => {
                    if (!ipc.send) return reject(new Error('IPC não disponível'));
                    pendingPdfRequests.set(id, { resolve, reject });
                    ipc.send({ type: 'PRINT_HTML', id, htmlContent: zpl_content, printerName: pName });

                    setTimeout(() => {
                        if (pendingPdfRequests.has(id)) {
                            pendingPdfRequests.delete(id);
                            reject(new Error('Timeout ao imprimir HTML'));
                        }
                    }, 20000); // 20 seg para imagens, fonts na cache, etc
                });
            } else {
                if (state.currentConfig.printerType === 'usb') {
                    await printerUSB.print(id, zpl_content);
                } else {
                    await printerNetwork.print(id, zpl_content);
                }
            }

            state.stats.successJobs++;
            state.stats.lastJobTime = new Date();

            if (!isLocalJob) {
                await database.updateJobStatus(id, 'printed');
            }
            logger.info('JOB', `Job ${id} concluído com sucesso. (total=${state.stats.totalJobs}, ok=${state.stats.successJobs})`);
            // Push para o frontend (mesmo ID que o cliente enviou no batch)
            try {
                const wsBroadcast = require('./src/core/wsBroadcast');
                wsBroadcast.broadcast('job-progress', { id, status: 'printed', source: source || 'queue' });
            } catch { /* ignore */ }
            // Sinaliza para quem aguarda síncronamente (ex.: /api/local-print)
            jobEmitter.emit(`done:${id}`, { ok: true });
        } catch (e) {
            state.stats.failedJobs++;
            state.stats.lastJobTime = new Date();

            logger.error('JOB', `Falha no Job ${id}`, e.message);
            if (!isLocalJob) {
                await database.updateJobStatus(id, 'error', e.message);
            }
            try {
                const wsBroadcast = require('./src/core/wsBroadcast');
                wsBroadcast.broadcast('job-progress', { id, status: 'error', error: e.message, source: source || 'queue' });
            } catch { /* ignore */ }
            jobEmitter.emit(`done:${id}`, { ok: false, error: e.message });
        } finally {
            setTimeout(() => processedJobIds.delete(id), 60000);
        }
    };

    const runQueue = async () => {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        try {
            while (jobQueue.length > 0) {
                const nextJob = jobQueue.shift();
                try {
                    await processJob(nextJob);
                } catch (e) {
                    logger.error('QUEUE', 'Erro no processamento de um job individual', e.message);
                }
                // Pequeno delay para dar respiro ao spooler/socket
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (e) {
            logger.error('QUEUE', 'Erro fatal na execução da fila', e.stack);
        } finally {
            isProcessingQueue = false;
            if (jobQueue.length === 0) {
                logger.info('QUEUE', 'Fila de processamento concluída.');
            }
        }
    };

    // Exposto para o controller (POST /api/local-print-batch) usar a mesma fila
    // sequencial que o Realtime usa. Garante ordem + mutex + delay de 500ms entre jobs.
    global.enqueueLocalJob = (job) => {
        if (!job || !job.id) return false;
        if (processedJobIds.has(job.id)) {
            logger.warn('QUEUE', `Job ${job.id} duplicado ignorado (enqueueLocalJob)`);
            return false;
        }
        processedJobIds.add(job.id);
        jobQueue.push(job);
        runQueue();
        return true;
    };
    global.getQueueLength = () => jobQueue.length;

    // Handler apenas adiciona à fila
    socket.setHandler((job) => {
        if (processedJobIds.has(job.id)) {
            logger.warn('QUEUE', `Job ${job.id} duplicado recebido. Ignorando.`);
            return;
        }

        logger.info('QUEUE', `Adicionando Job ${job.id} à fila de anti-colisão.`);
        processedJobIds.add(job.id);
        jobQueue.push(job);
        runQueue();
    });

    // 3. Se autenticado, conecta aos serviços Cloud
    if (isAuthenticated) {
        const hasConfig = await database.syncConfig();
        if (hasConfig) {
            socket.connect(); // Inicia Realtime
            socket.startPolling(); // Inicia Polling (Fallback do Legacy)
            monitor.start();  // Inicia Monitoramento
        }
    } else {
        logger.warn('MAIN', 'Agente não autenticado. Aguardando login via Dashboard.');
    }

    // Heartbeat 60s (frontend tolera 2min) — metade das writes no banco.
    setInterval(() => database.sendHeartbeat(), 60000);
    if (state.isAuthenticated()) database.sendHeartbeat();

    // 4. Inicia Servidor Local (UI)
    server.start();

    // 5. IPC Loop do Tray — agora com diff: só envia se algo mudou.
    if (ipc.send) {
        let lastPayloadJson = '';
        setInterval(() => {
            const payload = {
                status: state.connStatus,
                printerName: state.currentConfig.printerName || state.currentConfig.printerIdentifier || 'Não Config.',
                printerStatus: state.printerStatus && state.printerStatus.isOnline
                    ? (state.printerStatus.message || 'Online')
                    : (state.connStatus === 'SUBSCRIBED' ? 'Aguardando' : 'Inativo')
            };
            const json = JSON.stringify(payload);
            if (json !== lastPayloadJson) {
                lastPayloadJson = json;
                ipc.send({ type: 'UPDATE_DATA', payload });
            }
        }, 5000);
    }
}

// Global Error Handlers
process.on('uncaughtException', (err) => logger.error('FATAL', 'Uncaught Exception', err.stack || err.message));
process.on('unhandledRejection', (reason) => logger.error('FATAL', 'Unhandled Rejection', reason instanceof Error ? reason.stack : reason));

// Graceful Shutdown
const shutdown = () => {
    logger.info('MAIN', 'Desligando agente...');
    monitor.stop();
    socket.disconnect();
    try { pshost.stop(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 500);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', () => {
    logger.info('MAIN', 'Processo pai desconectado (Electron fechou). Encerrando...');
    shutdown();
});

// IPC Listener for Tray Actions & PDF Results
process.on('message', async (msg) => {
    // Plug/unplug detectado pelo Electron via WM_DEVICECHANGE — dispara um refresh
    // único do monitor (em vez de polling). Custo idle = 0.
    if (msg.type === 'DEVICE_CHANGE') {
        monitor.onDeviceChange('WM_DEVICECHANGE').catch(() => {});
        return;
    }
    // Espelha estado do autoUpdater recebido do main.js para o UI local
    // poder consultar via /api/status (sem precisar de IPC adicional).
    if (msg.type === 'UPDATE_STATUS') {
        state.updateStatus = msg.payload || null;
        return;
    }
    // Resposta de uma ação solicitada por endpoints REST (download/install/skip/check)
    if (msg.type === 'UPDATE_ACTION_RESULT') {
        const waiter = updateActionWaiters.get(msg.requestId);
        if (waiter) {
            clearTimeout(waiter.timer);
            updateActionWaiters.delete(msg.requestId);
            // msg pode ter { ok, error, state, ... } — passa tudo
            const { type, requestId, ...result } = msg;
            waiter.resolve(result);
        }
        return;
    }
    // Resultado da impressão direta de etiqueta de teste (handler no main.js)
    if (msg.type === 'PRINT_TEST_LABEL_RESULT' || msg.type === 'PRINT_HTML_RESULT') {
        const resolver = pendingPdfRequests.get(msg.id);
        if (resolver) {
            if (msg.success) resolver.resolve();
            else resolver.reject(new Error(msg.error || 'Falha na impressão'));
            pendingPdfRequests.delete(msg.id);
        }

    } else if (msg.type === 'RUN_TEST_PRINT') {
        logger.info('MAIN', 'Solicitação de Teste de Impressão via Tray');
        const printerName = state.currentConfig.printerName || state.currentConfig.printerIdentifier;
        if (!printerName) {
            logger.warn('MAIN', 'Teste via Tray: impressora não configurada.');
            return;
        }
        try {
            // Re-declare printerName to ensure it's available in this scope if the outer one was skipped
            const printerName = state.currentConfig.printerName || state.currentConfig.printerIdentifier;
            if (!printerName) throw new Error('Impressora não configurada.');
            await requestTestPrint(state.companyName, printerName);
            logger.info('MAIN', 'Teste de impressão (Tray) enviado.');
        } catch (e) {
            logger.error('MAIN', 'Erro no teste de impressão (Tray)', e.message);
        }

    } else if (msg.type === 'FORCE_CLEAR_QUEUE') {
        logger.info('MAIN', 'Solicitação de Limpeza de Fila via Tray');
        if (state.currentConfig.printerName) {
            try {
                await printerUSB.fixQueue(state.currentConfig.printerName);
                if (ipc.send) ipc.send({ type: 'NOTIFICATION', title: 'Fila Limpa', body: 'A fila de impressão foi reiniciada.' });
            } catch (e) {
                logger.error('MAIN', 'Erro ao limpar fila', e.message);
            }
        }

    } else if (msg.type === 'ENCRYPT_RESULT' || msg.type === 'DECRYPT_RESULT') {
        // Tratado no módulo auth.js
    }
});

// Start
bootstrap();
