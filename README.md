# OnTrack Printer Agent

Agente desktop (Electron) que recebe trabalhos de impressão térmica do sistema
OnTrack — via fila do Supabase Realtime e/ou impressão direta local na máquina
do usuário (`http://127.0.0.1:9876`).

## Atualização Automática

A partir da versão **3.7.0**, o agent verifica e instala atualizações
automaticamente via **GitHub Releases**, no boot do app. Não é mais necessário
distribuir um link manualmente — o próprio agent puxa a versão mais nova.

Fluxo:

1. Você cria uma tag git semântica: `git tag v3.7.1 && git push --tags`.
2. **GitHub Actions** roda em `windows-latest`: executa `npm test` (90 testes)
   e em seguida `npm run release` (electron-builder com `--publish always`).
3. O instalador `OnTrack-Agent-Setup-3.7.1.exe`, o `latest.yml` e o `.blockmap`
   (delta) são anexados ao release.
4. Cada agent instalado, no próximo boot, faz fetch do `latest.yml`,
   compara versões, baixa o delta e marca como pronto.
5. Usuário clica "Reiniciar e atualizar" no tray (ou simplesmente fecha e abre
   o agent — `autoInstallOnAppQuit = true`).

### Sem code-signing

A primeira instalação manual mostra o aviso do SmartScreen ("Aplicativo não
reconhecido" → "Mais informações" → "Executar mesmo assim"). Auto-updates
subsequentes são silenciosos porque substituem binário no mesmo path.

## Como publicar uma release

```bash
# 1. Bump local da versão (também atualize agent.js, controllers.js, public/*.html)
npm version 3.7.1 --no-git-tag-version

# 2. Commit
git add -A && git commit -m "release: v3.7.1"

# 3. Tag + push
git tag v3.7.1
git push && git push --tags

# 4. Acompanhe em Actions
# https://github.com/<owner>/<repo>/actions
```

O workflow publica o release **automaticamente** assim que os testes passam.

## Desenvolvimento

```bash
npm ci
npm start           # roda em modo dev (autoUpdater desabilitado)
npm test            # 90 testes — também roda no predist e prerelease
npm run dist        # build local (sem publicar)
npm run release     # build + publica no GitHub (precisa GH_TOKEN)
```

## Segurança

- **Supabase**: agente usa a chave `anon` (pública por design). Acesso real
  protegido por **RLS**:
  - `printer_settings.company_id = current_tenant_id()`
  - `print_queue.company_id = current_tenant_id()`
- **Sessão local**: refresh tokens armazenados em
  `%APPDATA%/OnTrack Agent/data/session.secure` criptografados via
  `Electron safeStorage` (CryptUnprotectData no Windows).
- **Validação de impressora**: 4 camadas (controller → agent.js → IPC →
  main.js) bloqueiam impressão acidental na **default printer** do Windows.
- **Logs com mascaramento**: JWTs, UUIDs e URLs Supabase são redacted antes de
  escrever em disco.

## Arquitetura

```
   Frontend (Next.js/PWA)
       ↓ HTTP + WS
   127.0.0.1:9876 (Express + ws)
       ↓ IPC (child_process.fork)
   main.js (Electron)
       ├─ persistentSpoolerWindow (offscreen, 400×800, backgroundThrottling)
       ├─ Tray + Notifications
       ├─ WM_DEVICECHANGE listener
       └─ autoUpdater (GitHub Releases)
   agent.js (Node child process)
       ├─ jobQueue (mutex, FIFO, anti-collision)
       ├─ PSHost (PowerShell REPL persistente — 1× spawn, query múltiplas)
       ├─ Monitor (revalida em DEVICE_CHANGE + 60s tick)
       └─ Supabase Realtime (Watch print_queue + heartbeat printer_settings)
```

## Testes

- **70+** testes do agent: regressão estática, integração com PowerShell real,
  WebSocket broadcast, validação de impressora, PSHost lifecycle.
- **45** testes do frontend (vitest).
- `predist` e `prerelease` rodam tudo automaticamente — build aborta se
  algum falhar.
