/* ============================================================
   Tray Popup — renderiza estado em tempo real
   - Recebe state via window.trayAPI.onStateUpdate (preload bridge)
   - Dispatch ações via window.trayAPI.send(action)
   ============================================================ */

(function () {
    'use strict';

    if (!window.trayAPI) {
        console.error('[tray-popup] window.trayAPI ausente — preload falhou');
        return;
    }

    // Cache de elementos
    const $ = (id) => document.getElementById(id);
    const el = {
        currentVersion: $('currentVersion'),
        sysDot: $('sysDot'),
        sysStatusValue: $('sysStatusValue'),
        prnDot: $('prnDot'),
        prnNameValue: $('prnNameValue'),
        prnDetailDot: $('prnDetailDot'),
        prnStatusValue: $('prnStatusValue'),

        updateSection: $('updateSection'),
        updateIcon: $('updateIcon'),
        updateTitle: $('updateTitle'),
        updateSubtitle: $('updateSubtitle'),
        updateProgress: $('updateProgress'),
        updateProgressFill: $('updateProgressFill'),
        updateProgressLabel: $('updateProgressLabel'),
        updateActions: $('updateActions'),

        btnCheckUpdates: $('btnCheckUpdates'),
        checkUpdatesIcon: $('checkUpdatesIcon'),
        checkUpdatesLabel: $('checkUpdatesLabel'),
    };

    // Helpers de status (sistema + impressora) — mesma lógica do tray nativo
    function classifySys(status) {
        const s = (status || '').toUpperCase();
        if (s.includes('ONLINE') || s.includes('SUBSCRIBED') || s.includes('CONNECTED')) return 'on';
        if (s.includes('INICIANDO') || s.includes('CONNECTING') || s === '...') return 'wait';
        return 'off';
    }

    function classifyPrn(status, name) {
        const s = (status || '').toUpperCase();
        if (name === 'Detectando...' || s === '...' || s.includes('DETECTANDO') || s.includes('AGUARDANDO')) return 'wait';
        if (s.includes('ONLINE') || s.includes('PRONTA') || s.includes('IMPRIMINDO') || s.includes('IDLE')) return 'on';
        return 'off';
    }

    function setDot(dotEl, kind) {
        dotEl.classList.remove('is-on', 'is-wait', 'is-off');
        dotEl.classList.add('is-' + kind);
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    // ── Render principal ─────────────────────────────────────
    function applyTheme(theme) {
        const html = document.documentElement;
        if (theme === 'dark') html.classList.add('dark');
        else if (theme === 'light') html.classList.remove('dark');
        // se theme indefinido, não mexe (preserva o anti-flash inicial)
    }

    function render(state) {
        // Tema vem do nativeTheme do Electron (segue o Windows automaticamente)
        applyTheme(state.theme);

        const agent = state.agent || {};
        const update = state.update || {};

        // Versão atual
        if (update.currentVersion) {
            el.currentVersion.textContent = `v${update.currentVersion}`;
        }

        // Status sistema
        el.sysStatusValue.textContent = agent.status || '—';
        setDot(el.sysDot, classifySys(agent.status));

        // Status impressora (nome)
        el.prnNameValue.textContent = agent.printerName || '—';
        setDot(el.prnDot, classifyPrn(agent.printerStatus, agent.printerName));

        // Status impressora (mensagem detalhada)
        el.prnStatusValue.textContent = agent.printerStatus || '—';
        setDot(el.prnDetailDot, classifyPrn(agent.printerStatus, agent.printerName));

        // ── Update section ───────────────────────────────────
        const status = update.status || 'idle';
        const v = update.version;
        const hasNew = v && update.currentVersion && v !== update.currentVersion;
        const showUpdate = (status === 'available' && hasNew) ||
                            status === 'downloading' ||
                            status === 'ready' ||
                            status === 'error';

        if (showUpdate) {
            el.updateSection.style.display = '';
            el.updateSection.classList.remove('is-checking', 'is-downloading', 'is-ready', 'is-error');

            if (status === 'available' && v) {
                el.updateIcon.textContent = 'system_update';
                el.updateTitle.textContent = `Atualização disponível: v${v}`;
                el.updateSubtitle.textContent = `Você está em v${update.currentVersion}.`;
                el.updateProgress.style.display = 'none';
                el.updateActions.innerHTML = `
                    <button class="popup-btn-action primary" data-action="update-download-and-install">Baixar e instalar</button>
                    <button class="popup-btn-action ghost" data-action="update-skip" data-version="${escapeHtml(v)}">Pular esta versão</button>`;
            } else if (status === 'downloading' && v) {
                el.updateSection.classList.add('is-downloading');
                el.updateIcon.textContent = 'downloading';
                const autoTxt = update.autoInstall ? ' (instala ao terminar)' : '';
                el.updateTitle.textContent = `Baixando v${v}${autoTxt}`;
                el.updateSubtitle.textContent = `Acompanhe o progresso abaixo.`;
                el.updateProgress.style.display = '';
                const pct = update.progress || 0;
                el.updateProgressFill.style.width = pct + '%';
                el.updateProgressLabel.textContent = pct + '%';
                el.updateActions.innerHTML = '';
            } else if (status === 'ready' && v) {
                el.updateSection.classList.add('is-ready');
                el.updateIcon.textContent = 'task_alt';
                el.updateTitle.textContent = `Pronta para instalar: v${v}`;
                el.updateSubtitle.textContent = `Reinicie para aplicar.`;
                el.updateProgress.style.display = 'none';
                el.updateActions.innerHTML = `
                    <button class="popup-btn-action success" data-action="update-install">Instalar e reiniciar</button>
                    <button class="popup-btn-action ghost" data-action="update-skip" data-version="${escapeHtml(v)}">Pular esta versão</button>`;
            } else if (status === 'error') {
                el.updateSection.classList.add('is-error');
                el.updateIcon.textContent = 'error';
                el.updateTitle.textContent = `Falha ao verificar atualização`;
                el.updateSubtitle.textContent = update.error || 'Tente novamente em instantes.';
                el.updateProgress.style.display = 'none';
                el.updateActions.innerHTML = '';
            }
        } else {
            el.updateSection.style.display = 'none';
        }

        // ── Botão "Verificar atualizações" — spinner em checking ─
        const checking = status === 'checking' || status === 'downloading';
        if (status === 'checking') {
            el.checkUpdatesLabel.textContent = 'Verificando...';
            el.checkUpdatesIcon.classList.add('is-spinning');
            el.btnCheckUpdates.disabled = true;
        } else if (status === 'downloading') {
            el.checkUpdatesLabel.textContent = 'Baixando...';
            el.checkUpdatesIcon.classList.add('is-spinning');
            el.btnCheckUpdates.disabled = true;
        } else {
            el.checkUpdatesLabel.textContent = 'Verificar atualizações';
            el.checkUpdatesIcon.classList.remove('is-spinning');
            el.btnCheckUpdates.disabled = !update.canCheck;
        }
    }

    // ── Wiring de eventos ────────────────────────────────────
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const version = btn.dataset.version;
        window.trayAPI.send(action, version ? { version } : undefined);
    });

    // ESC fecha o popup
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.trayAPI.send('close');
    });

    // Estado vem por subscription do preload
    window.trayAPI.onStateUpdate((state) => {
        try { render(state); } catch (err) { console.error('[tray-popup] render error:', err); }
    });

    // Solicita o estado inicial assim que carrega
    window.trayAPI.send('request-state');
})();
