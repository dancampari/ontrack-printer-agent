const state = require('../config/state');
const auth = require('../core/auth');
const database = require('../core/database');
const printerUSB = require('../services/printerUSB');
const printerPDF = require('../services/printerPDF');
const socket = require('../core/socket');
const logger = require('../utils/logger');
const pshost = require('../core/pshost');
const wsBroadcast = require('../core/wsBroadcast');
const { safePrinterName } = require('../utils/printerValidator');

// Cache leve para /api/printers — evita PowerShell em cada poll do frontend.
const PRINTERS_CACHE_TTL_MS = 30_000;
let printersCache = { at: 0, list: null };

const Controllers = {
    // Middleware de Autenticação
    requireAuth: (req, res, next) => {
        if (!state.isAuthenticated()) {
            return res.status(401).json({ error: 'Nâo autenticado' });
        }
        next();
    },

    // Rota: POST /login
    login: async (req, res) => {
        const { email, password, remember } = req.body;
        try {
            const success = await auth.login(email, password);
            if (success) {
                // Login manual bem-sucedido: limpa flag de logout explícito
                state.explicitLogout = false;

                // Handle "Remember Me"
                if (remember) {
                    await auth.saveCredentials(email, password);
                } else {
                    // If user explicitly uncheck remember, we clear any previously saved ones
                    await auth.clearCredentials();
                }

                // Após login, tenta sync de config
                const hasConfig = await database.syncConfig();
                if (hasConfig) {
                    // INICIA O REALTIME AGORA
                    socket.connect();
                    socket.startPolling(); // Inicia Polling (Fallback)

                    // INICIA O MONITOR (CRÍTICO!)
                    const monitor = require('../services/monitor');
                    monitor.start();
                }
                res.json({ ok: true, companyId: state.companyId });
            } else {
                res.status(401).json({ ok: false, error: 'Credenciais inválidas ou usuário sem empresa.' });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: GET /api/saved-credentials
    getSavedCredentials: async (req, res) => {
        try {
            const creds = await auth.loadCredentials();
            if (creds) {
                res.json({ ok: true, email: creds.email, password: creds.password });
            } else {
                res.json({ ok: false });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: POST /api/auto-login (Silent Auto-Login)
    tryAutoLogin: async (req, res) => {
        try {
            // Bloqueia se o usuário fez logout explícito nesta sessão
            if (state.explicitLogout) {
                logger.info('AUTH', 'Auto-login bloqueado: logout explícito ativo.');
                return res.json({ ok: false, reason: 'explicit_logout' });
            }

            // Try to load saved credentials
            const creds = await auth.loadCredentials();
            if (!creds || !creds.email || !creds.password) {
                return res.json({ ok: false, reason: 'no_credentials' });
            }

            logger.info('AUTH', `Tentando auto-login para: ${creds.email}`);

            // Attempt login with saved credentials
            const success = await auth.login(creds.email, creds.password);
            if (success) {
                // Após login, tenta sync de config
                const hasConfig = await database.syncConfig();
                if (hasConfig) {
                    // INICIA O REALTIME AGORA
                    socket.connect();
                    socket.startPolling(); // Inicia Polling (Fallback)

                    // INICIA O MONITOR (CRÍTICO!)
                    const monitor = require('../services/monitor');
                    monitor.start();
                }
                logger.info('AUTH', 'Auto-login bem-sucedido.');
                res.json({ ok: true, companyId: state.companyId });
            } else {
                logger.warn('AUTH', 'Auto-login falhou - credenciais inválidas.');
                res.json({ ok: false, reason: 'invalid_credentials' });
            }
        } catch (e) {
            logger.error('AUTH', 'Erro no auto-login:', e.message);
            res.json({ ok: false, reason: 'error', error: e.message });
        }
    },

    // Rota: POST /api/logout
    logout: async (req, res) => {
        try {
            await auth.logout();         // Aguarda state.reset() completar
            state.explicitLogout = true; // Seta APÓS o reset para não ser apagado
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: GET /api/health (público) — usado pelo badge no sidebar do dashboard.
    // Devolve só o suficiente para detecção rápida; nada sensível.
    health: (req, res) => {
        res.json({
            status: 'ok',
            version: '3.7.1',
            authenticated: state.isAuthenticated(),
            printerConfigured: !!(state.currentConfig.printerName || state.currentConfig.printerIdentifier),
            defaultPrinter: state.currentConfig.printerName || state.currentConfig.printerIdentifier || null,
            printerOnline: state.printerStatus ? !!state.printerStatus.isOnline : false,
            connStatus: state.connStatus,
            // Estado do autoUpdater (espelhado via IPC do main.js)
            update: state.updateStatus || { status: 'idle' },
        });
    },

    // Rota: GET /api/status
    getStatus: (req, res) => {
        const safeConfig = { ...state.currentConfig };

        // Calculate Uptime
        const now = new Date();
        const start = state.stats.startTime ? new Date(state.stats.startTime) : now;
        state.stats.uptime = Math.floor((now - start) / 1000);

        res.json({
            status: state.connStatus,
            config: safeConfig,
            config: safeConfig,
            company: state.companyId,
            companyName: state.companyName,
            printerStatus: state.printerStatus, // EXPOSED HERE
            stats: state.stats,
            logs: logger.getBuffer()
        });
    },

    // Rota: POST /config
    saveConfig: async (req, res) => {
        const { printerType, printerName, printerIp, printerPort, printerNickname } = req.body;

        const newConfig = {
            printerType,
            printerName: printerType === 'usb' ? printerName : (printerNickname || 'Impressora de Rede')
        };

        if (printerType === 'network') {
            // Se tiver porta customizada, salva como IP:PORT
            if (printerPort && printerPort !== '9100') {
                newConfig.printerIdentifier = `${printerIp}:${printerPort}`;
            } else {
                newConfig.printerIdentifier = printerIp;
            }
        } else {
            newConfig.printerIdentifier = printerName; // USB usa o nome como ID
        }

        try {
            await database.saveConfig(newConfig);
            // GARANTE CONEXÃO SE ERA A FALTA DE CONFIG
            socket.connect();

            // Notifica clientes WS imediatamente — frontend invalida cache do probe
            // e o badge no sidebar atualiza em <200ms.
            wsBroadcast.broadcast('config-changed', { config: state.currentConfig });

            // E dispara um refresh real no monitor (sem esperar o tick de 60s),
            // que vai emitir um 'status-update' assim que validar a nova impressora.
            const monitor = require('../services/monitor');
            monitor.onDeviceChange('config-changed').catch(() => {});

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: GET /api/printers — usa PSHost + cache 30s (sem spawn de PowerShell).
    getPrinters: async (req, res) => {
        const now = Date.now();
        if (printersCache.list && (now - printersCache.at) < PRINTERS_CACHE_TTL_MS) {
            return res.json(printersCache.list);
        }
        try {
            const result = await pshost.runJson(`Get-Printer | Select-Object Name`);
            const list = Array.isArray(result) ? result : (result ? [result] : []);
            printersCache = { at: now, list };
            res.json(list);
        } catch (e) {
            logger.warn('API', '/api/printers falhou', e.message);
            res.json([]);
        }
    },

    // Rota: GET /api/doctor/diagnose
    diagnose: async (req, res) => {
        const printerStatus = state.printerStatus || { isOnline: false, pendingJobs: 0 };

        const realStatus = {
            Name: state.currentConfig.printerName || 'Impressora',
            Status: printerStatus.isOnline ? 'Online' : 'Offline',
            WorkOffline: !printerStatus.isOnline,
            JobCount: printerStatus.pendingJobs || 0,
            LastCheck: printerStatus.lastCheck
        };
        res.json({ ok: true, data: realStatus });
    },

    // Rota: POST /api/doctor/fix
    fix: async (req, res) => {
        logger.info('DOCTOR', 'Solicitação de correção recebida (Fix Spooler).');

        try {
            const { printerType, printerName } = state.currentConfig;
            let count = 0;

            if (printerType === 'usb' && printerName) {
                count = await printerUSB.fixQueue(printerName);
            } else {
                // Para rede, tentamos apenas reiniciar o Spooler geral (requer admin, pode falhar)
                // ou simplesmente limpamos os contadores de erro.
                // TODO: Implementar limpeza específica de fila de rede se possível via SNMP ou Spooler
                logger.warn('DOCTOR', 'Limpeza profundada disponível apenas para USB no momento. Resetando contadores.');
            }

            // Resetamos contadores de erro do estado
            state.stats.failedJobs = 0;

            res.json({ ok: true, cleanedCount: count });
        } catch (e) {
            logger.error('DOCTOR', 'Falha ao corrigir fila', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // ── Auto-update endpoints ────────────────────────────────────────────
    // GET /api/update — retorna estado atual completo (status, info, progresso,
    // changelog, skipped, currentVersion). Banner do UI faz polling disto.
    updateStatus: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.json({ status: 'idle', currentVersion: state.updateStatus?.currentVersion || null });
            }
            const r = await global.requestUpdateAction('status', {}, 5_000);
            if (r.ok && r.state) return res.json(r.state);
            return res.json(state.updateStatus || { status: 'idle' });
        } catch (e) {
            res.json(state.updateStatus || { status: 'idle' });
        }
    },

    // POST /api/update/check — força checagem manual no GitHub Releases.
    updateCheck: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('check', {}, 30_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // POST /api/update/download — usuário consentiu em baixar.
    updateDownload: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            // Não esperamos o download completo (pode demorar) — só confirmamos início.
            const r = await global.requestUpdateAction('download', {}, 10_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // POST /api/update/install — usuário escolheu reiniciar agora.
    updateInstall: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('install', {}, 5_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // POST /api/update/skip — usuário pulou a versão atual.
    updateSkip: async (req, res) => {
        try {
            const version = (req.body && req.body.version) || null;
            if (!version) return res.status(400).json({ ok: false, error: 'Body deve conter { version }.' });
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('skip', { version }, 5_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: POST /api/local-print-batch
    // Recebe um lote de jobs e os empilha na MESMA fila sequencial que o
    // Realtime/Polling usa. Garante ordem + mutex + delay entre jobs sem o
    // frontend precisar fazer N round-trips HTTP.
    //
    // Body: { jobs: [{ id?, html }, ...], printerName? }
    // Resp: { ok, acceptedIds: [...], total, queueLength }
    //
    // Progresso é entregue via WS push (type='job-progress', payload={id,status,error?}).
    localPrintBatch: async (req, res) => {
        logger.info('API', 'Recebido lote de impressão local.');
        try {
            const { jobs, printerName } = req.body || {};
            if (!Array.isArray(jobs) || jobs.length === 0) {
                return res.status(400).json({ ok: false, error: 'Campo "jobs" deve ser array não-vazio.' });
            }
            if (typeof global.enqueueLocalJob !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent ainda não pronto para enfileirar.' });
            }
            const targetPrinter = safePrinterName(
                printerName,
                state.currentConfig.printerName,
                state.currentConfig.printerIdentifier,
            );
            if (!targetPrinter) {
                return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
            }

            const acceptedIds = [];
            for (const j of jobs) {
                if (!j || typeof j.html !== 'string' || !j.html.trim()) continue;
                const id = (typeof j.id === 'string' && j.id)
                    ? j.id
                    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const enqueued = global.enqueueLocalJob({
                    id,
                    source: 'local-batch',
                    job_type: 'html',
                    zpl_content: j.html,
                    printer_name: targetPrinter,
                });
                if (enqueued) acceptedIds.push(id);
            }

            const queueLength = typeof global.getQueueLength === 'function' ? global.getQueueLength() : null;
            logger.info('API', `Lote enfileirado: ${acceptedIds.length}/${jobs.length} aceitos (fila atual=${queueLength}).`);
            res.json({ ok: true, acceptedIds, total: acceptedIds.length, queueLength });
        } catch (e) {
            logger.error('API', 'Falha no lote local', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: POST /api/local-print
    // Agora enfileira pelo MESMO `processJob` que serve Realtime/batch — assim
    // ganha stats centralizadas (totalJobs/successJobs/failedJobs), ordem FIFO
    // com o batch, e broadcast WS automático. Mantém o contrato HTTP síncrono
    // aguardando o evento `done:<id>` do jobEmitter.
    localPrint: async (req, res) => {
        logger.info('API', 'Recebida solicitação de impressão local direta.');
        try {
            const { content, printerName } = req.body || {};
            if (!content) {
                return res.status(400).json({ ok: false, error: 'Conteúdo HTML obrigatório.' });
            }
            const targetPrinter = safePrinterName(
                printerName,
                state.currentConfig.printerName,
                state.currentConfig.printerIdentifier,
            );
            if (!targetPrinter) {
                return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
            }
            if (typeof global.enqueueLocalJob !== 'function' || !global.jobEmitter) {
                return res.status(503).json({ ok: false, error: 'Agent ainda não pronto para enfileirar.' });
            }

            const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Registra o waiter ANTES de enfileirar — evita race se o job terminar
            // muito rápido (queue vazia + spooler quente).
            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    global.jobEmitter.off(`done:${id}`, handler);
                    resolve({ ok: false, error: 'Timeout aguardando impressão (30s).' });
                }, 30_000);
                const handler = (r) => {
                    clearTimeout(timer);
                    resolve(r);
                };
                global.jobEmitter.once(`done:${id}`, handler);

                const enqueued = global.enqueueLocalJob({
                    id,
                    source: 'local-single',
                    job_type: 'html',
                    zpl_content: content,
                    printer_name: targetPrinter,
                });
                if (!enqueued) {
                    clearTimeout(timer);
                    global.jobEmitter.off(`done:${id}`, handler);
                    resolve({ ok: false, error: 'Falha ao enfileirar job.' });
                }
            });

            if (result.ok) {
                return res.json({ ok: true, jobId: id, message: 'Impresso com sucesso.' });
            }
            return res.status(500).json({ ok: false, jobId: id, error: result.error || 'Falha na impressão.' });
        } catch (e) {
            logger.error('API', 'Falha na impressão local', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: POST /api/test-print
    testPrint: async (req, res) => {
        logger.info('API', 'Recebida solicitaçao de teste de impressão.');

        const printerName = safePrinterName(
            state.currentConfig.printerName,
            state.currentConfig.printerIdentifier,
        );
        const printerType = state.currentConfig.printerType;
        if (!printerName) {
            return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
        }

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const companyName = (state.companyName || 'OnTrack Empresa').toUpperCase();

        // Recibo de teste OnTrack — formato térmico 72mm (mesmo pipeline dos recibos reais)
        const receiptHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Courier New', monospace; font-size: 11px; width: 72mm; color: #000; background: #fff; }
.center { text-align: center; }
.bold { font-weight: bold; }
.line { border-top: 1px dashed #000; margin: 4px 0; }
.row { display: flex; justify-content: space-between; }
.header { font-size: 14px; font-weight: bold; text-align: center; margin-bottom: 2px; letter-spacing: 1px; }
.sub { font-size: 10px; text-align: center; color: #444; margin-bottom: 4px; }
.label { font-size: 9px; color: #555; text-transform: uppercase; margin-bottom: 1px; }
p { margin: 2px 0; }
</style></head><body>
<p class="header">OnTrack</p>
<p class="sub">Sistema de Gestão de Funcionários</p>
<div class="line"></div>
<p class="center bold">*** IMPRESSÃO DE TESTE ***</p>
<div class="line"></div>
<p class="label">Empresa</p>
<p class="bold">${companyName.substring(0, 32)}</p>
<div class="line"></div>
<p class="label">Recibo de Pagamento (Exemplo)</p>
<p>Funcionário: João da Silva</p>
<p>Período: 01/03/2026 a 07/03/2026</p>
<div class="line"></div>
<div class="row"><span>Salário base:</span><span>R$ 1.518,00</span></div>
<div class="row"><span>Horas extras (8h):</span><span>R$ 113,85</span></div>
<div class="row"><span>Adiantamento:</span><span>- R$ 200,00</span></div>
<div class="line"></div>
<div class="row"><span class="bold">TOTAL LÍQUIDO:</span><span class="bold">R$ 1.431,85</span></div>
<div class="line"></div>
<p class="center">Assinatura: ___________________</p>
<p class="center" style="margin-top:6px; font-size:10px;">Impresso em: ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}</p>
<p class="center" style="margin-top:4px; font-size:9px; color:#666;">OnTrack — Agente de Impressão v3.7.1</p>
</body></html>`;

        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const cp = require('child_process');

        try {
            logger.info('API', `Teste OnTrack: impressora="${printerName}"`);

            if (typeof global.requestTestPrint === 'function') {
                // Caminho padrão: IPC → main.js → test-label.html → SumatraPDF
                await global.requestTestPrint(state.companyName || 'OnTrack', printerName);
            } else {
                // Fallback: salva HTML e envia direto via SumatraPDF
                const htmlPath = path.join(os.tmpdir(), `ontrack_test_${Date.now()}.html`);
                fs.writeFileSync(htmlPath, receiptHtml, 'utf8');

                const sumatraPath = printerPDF.getSumatraPath();
                if (!sumatraPath) throw new Error('SumatraPDF não encontrado. Verifique a instalação do agente.');

                logger.info('API', `Imprimindo HTML via SumatraPDF: ${sumatraPath}`);

                await new Promise((resolve, reject) => {
                    const proc = cp.spawn(sumatraPath, [
                        '-print-to', printerName,
                        '-print-settings', 'noscale',
                        '-silent',
                        '-exit-on-print',
                        htmlPath
                    ]);
                    proc.on('close', (code) => {
                        try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath); } catch (e) { }
                        if (code === 0) resolve();
                        else reject(new Error(`SumatraPDF encerrou com código ${code}`));
                    });
                    proc.on('error', reject);
                });
            }

            logger.info('API', 'Teste de impressão enviado com sucesso.');
            res.json({ ok: true });

        } catch (e) {
            logger.error('API', 'Falha no teste de impressão', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    }
};
module.exports = Controllers;



