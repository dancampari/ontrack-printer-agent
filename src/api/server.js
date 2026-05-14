const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const CONSTANTS = require('../config/constants');
const Controllers = require('./controllers');
const logger = require('../utils/logger');
const wsBroadcast = require('../core/wsBroadcast');
const agentToken = require('../core/agentToken');
const pkg = require('../../package.json');

const AGENT_VERSION = pkg.version;

/**
 * SECURITY (Phase 3B) — middleware de validação do X-Agent-Token.
 *
 * STATUS atual: SOFT MODE — permite requests sem token enquanto a coluna
 * `printer_settings.agent_token` no DB ainda não foi provisionada. Assim
 * que o sync de token for habilitado (após migration DB ser aprovada),
 * `agentToken.getToken()` retorna não-null e o middleware passa a enforced.
 *
 * Threat blocked (quando hard mode): processos LOCAIS (malware, extensão
 * de browser com host permissions, curl em ataque manual) que conseguem
 * chegar em 127.0.0.1 mesmo sem passar pelo CORS do browser.
 */
function requireAgentToken(req, res, next) {
    // SOFT MODE: token ainda não provisionado nesta instância — passa adiante.
    // (após DB migration + habilitação do sync no login, getToken() devolve
    // o token cacheado e a validação passa a ser estrita.)
    if (!agentToken.getToken()) {
        return next();
    }
    const provided = req.headers['x-agent-token'];
    if (!agentToken.validateToken(provided)) {
        logger.warn('AGENT_TOKEN', `Acesso rejeitado: token inválido ou ausente em ${req.path}`);
        return res.status(401).json({ ok: false, error: 'X-Agent-Token inválido ou ausente.' });
    }
    next();
}

class Server {
    start() {
        const app = express();
        app.disable('x-powered-by');

        // SECURITY (v3.9.7): CORS estrito. Antes, qualquer origem era aceita
        // (callback(null, true) em todos os branches) — site malicioso podia
        // mandar impressão via drive-by attack no browser. Agora só
        // *.sys-ontrack.com, vercel preview, e localhost dev passam.
        //
        // Origin vazio (mesma origem, file://, electron interno) continua
        // permitido para a UI local do agent acessar /login etc.
        const isAllowedOrigin = (origin) => {
            if (!origin) return true;
            if (/^https:\/\/([a-z0-9-]+\.)*sys-ontrack\.com$/.test(origin)) return true;
            if (/^https:\/\/([a-z0-9-]+-)?ontrack-sable\.vercel\.app$/.test(origin)) return true;
            if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
            return false;
        };

        app.use(cors({
            origin: function (origin, callback) {
                if (isAllowedOrigin(origin)) return callback(null, true);
                // Rejeição silenciosa (sem header Allow-Origin) — browser bloqueia.
                logger.warn('SERVER', `CORS: origem rejeitada → ${origin}`);
                return callback(null, false);
            },
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Token']
        }));

        app.use(bodyParser.json({ limit: '2mb' }));
        app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));

        const staticPath = path.join(__dirname, '..', '..', 'public');
        app.use(express.static(staticPath));

        app.post('/login', Controllers.login);
        // SECURITY (v3.9.7): /api/saved-credentials removido — expunha senha em
        // cleartext via HTTP local, acessível a qualquer processo na máquina.
        // Auto-login via token criptografado (session.secure) já cobre o caso
        // de "Lembrar-me" sem precisar nunca expor a senha de volta ao browser.
        app.post('/api/auto-login', Controllers.tryAutoLogin);
        app.post('/api/logout', Controllers.logout);

        // /api/health permanece sem token — o probe do frontend precisa dele
        // antes de saber se há agent local instalado. Nenhum dado sensível.
        app.get('/api/health', Controllers.health);
        // /api/local-print* exige X-Agent-Token a partir de v3.9.7.
        app.post('/api/local-print', requireAgentToken, Controllers.localPrint);
        app.post('/api/local-print-batch', requireAgentToken, Controllers.localPrintBatch);

        // Auto-update (controle manual: usuário decide quando baixar / instalar / pular)
        app.get('/api/update', Controllers.updateStatus);
        app.post('/api/update/check', Controllers.updateCheck);
        app.post('/api/update/download', Controllers.updateDownload);
        app.post('/api/update/install', Controllers.updateInstall);
        app.post('/api/update/skip', Controllers.updateSkip);

        app.get('/api/status', Controllers.requireAuth, Controllers.getStatus);
        app.post('/config', Controllers.requireAuth, Controllers.saveConfig);
        app.get('/api/printers', Controllers.getPrinters);

        app.get('/api/doctor/diagnose', Controllers.requireAuth, Controllers.diagnose);
        app.post('/api/doctor/fix', Controllers.requireAuth, Controllers.fix);
        app.post('/api/test-print', Controllers.requireAuth, Controllers.testPrint);

        app.get('*', (req, res) => {
            res.sendFile(path.join(staticPath, 'login.html'));
        });

        // http.createServer (não app.listen) — necessário para acoplar o WS server
        // na mesma porta. Mesma origem, mesmo socket TCP, sem CORS extra.
        const httpServer = http.createServer(app);
        wsBroadcast.attach(httpServer, { version: AGENT_VERSION });

        httpServer.listen(CONSTANTS.HTTP_PORT, '127.0.0.1', () => {
            logger.info('SERVER', `Interface Local e API Direta + WS rodando em 127.0.0.1:${CONSTANTS.HTTP_PORT}`);
        });

        httpServer.on('error', (e) => {
            logger.error('SERVER', 'Erro fatal ao iniciar servidor HTTP', e.message);
            if (e.code === 'EADDRINUSE') {
                logger.error('SERVER', `Porta ${CONSTANTS.HTTP_PORT} está em uso. Provável instância zumbi.`);
            }
        });
    }
}

module.exports = new Server();
