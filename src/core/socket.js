const state = require('../config/state');
const logger = require('../utils/logger');
const auth = require('./auth');

/**
 * Socket — Realtime + polling adaptativo.
 *
 * Antes: polling rodava a cada 15s SEMPRE, mesmo com Realtime SUBSCRIBED.
 * Agora:
 *  - Quando SUBSCRIBED: watchdog leve a cada 60s (sem query de jobs).
 *  - Quando NÃO SUBSCRIBED: polling de 15s reconecta e busca jobs pendentes.
 *  - Realtime cobre o caminho feliz; polling existe só como fallback de saúde.
 */

const RECONNECT_POLL_MS = 15_000;
const WATCHDOG_MS = 60_000;

class Socket {
    constructor() {
        this.subscription = null;
        this.handler = null;
        this.timer = null;
        this.timerKind = null; // 'reconnect' | 'watchdog'
    }

    setHandler(fn) {
        this.handler = fn;
    }

    connect() {
        if (!state.isAuthenticated()) {
            logger.warn('SOCKET', 'Não conectado: falta autenticação.');
            return;
        }
        if (this.subscription) this.disconnect();

        logger.info('SOCKET', `Iniciando Realtime para company_id: ${state.companyId}`);

        this.subscription = auth.client.channel('agent_queue')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'print_queue',
                    filter: `company_id=eq.${state.companyId}`
                },
                (payload) => {
                    logger.info('SOCKET', 'Novo job via Realtime', { id: payload.new.id });
                    if (this.handler) this.handler(payload.new);
                }
            )
            .subscribe((status, err) => {
                state.connStatus = status;
                logger.info('SOCKET', `Status: ${status}`);

                if (status === 'SUBSCRIBED') {
                    logger.info('SOCKET', 'Realtime ativo. Watchdog em modo leve.');
                    this._switchTimer('watchdog');
                    // Drena qualquer job que ficou pendente enquanto estávamos desconectados
                    this._drainPending().catch((e) => logger.warn('SOCKET', 'drain inicial falhou', e.message));
                } else if (err) {
                    logger.error('SOCKET', 'Erro na subscrição', err.message);
                    this._switchTimer('reconnect');
                }
            });

        // Enquanto não chega SUBSCRIBED, ficamos em modo reconnect
        this._switchTimer('reconnect');
    }

    /**
     * Compatibilidade com a API anterior. Apenas garante que o timer está
     * configurado conforme o status atual (watchdog se SUBSCRIBED, reconnect caso contrário).
     */
    startPolling() {
        if (state.connStatus === 'SUBSCRIBED') {
            this._switchTimer('watchdog');
        } else {
            this._switchTimer('reconnect');
        }
    }

    disconnect() {
        this._clearTimer();
        if (this.subscription) {
            try { auth.client.removeChannel(this.subscription); } catch { /* ignore */ }
            this.subscription = null;
            state.connStatus = 'DISCONNECTED';
            logger.info('SOCKET', 'Desconectado.');
        }
    }

    // ── Internos ───────────────────────────────────────────────────────────
    _switchTimer(kind) {
        if (this.timerKind === kind && this.timer) return;
        this._clearTimer();
        this.timerKind = kind;
        const interval = kind === 'watchdog' ? WATCHDOG_MS : RECONNECT_POLL_MS;

        this.timer = setInterval(async () => {
            if (!state.isAuthenticated()) return;

            if (kind === 'watchdog') {
                // Caminho feliz: Realtime ativo. Só verifica se ainda está SUBSCRIBED.
                if (state.connStatus !== 'SUBSCRIBED') {
                    logger.warn('WATCHDOG', `Status caiu para ${state.connStatus}. Reconectando...`);
                    this.connect(); // já recria timer
                }
                return;
            }

            // kind === 'reconnect': polling completo enquanto Realtime não sobe
            try {
                if (state.connStatus !== 'SUBSCRIBED') {
                    logger.warn('WATCHDOG', `Reconectando (status=${state.connStatus || 'null'})`);
                    this.connect();
                    return; // connect() já fará drain ao receber SUBSCRIBED
                }
            } catch (e) {
                logger.error('SOCKET', 'erro no reconnect', e.message);
            }

            // Fallback de jobs pendentes (caso Realtime esteja flaky)
            await this._drainPending().catch((e) => logger.error('SOCKET', 'erro no polling', e.message));
        }, interval);
    }

    _clearTimer() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.timerKind = null;
    }

    async _drainPending() {
        const { data, error } = await auth.client
            .from('print_queue')
            .select('*')
            .eq('company_id', state.companyId)
            .in('status', ['pending', 'processing']);
        if (error) throw error;
        if (data && data.length && this.handler) {
            logger.info('SOCKET', `Drenando ${data.length} job(s) pendente(s)`);
            for (const job of data) this.handler(job);
        }
    }
}

module.exports = new Socket();
