/**
 * Regressão estática — garante que os bugs corrigidos não voltem ao código.
 *
 * Esses testes leem o source dos arquivos e verificam padrões. Cobrem cenários
 * que seriam silenciosos em runtime mas que já causaram problema em produção.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const root = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('REGRESSÃO: monitor.js não usa $host = (variável reservada do PowerShell)', () => {
    const src = root('services/monitor.js');
    // Procuramos atribuições para $host. `$_.Host` ou `$_.HostAddress` são OK.
    assert.doesNotMatch(src, /\$host\s*=\s*/, '$host = não pode aparecer (read-only no PS)');
    assert.match(src, /\$portHost/, 'deve usar $portHost como nome alternativo');
});

test('REGRESSÃO: pshost.js usa REPL .ps1 (não powershell -Command -)', () => {
    const src = root('core/pshost.js');
    assert.match(src, /-File/, 'PSHost deve spawn com -File (REPL .ps1)');
    assert.match(src, /\[Console\]::In\.ReadLine\(\)/, 'REPL deve ler stdin linha a linha');
    assert.match(src, /\$\{BLOCK_TERMINATOR\}|###END_OF_BLOCK###/, 'deve haver terminador de bloco');
});

test('REGRESSÃO: pshost.js wrappa comando em & { } para evitar pipeline leak', () => {
    const src = root('core/pshost.js');
    // O bug era $r = ${command} (sem scriptblock) capturando só o primeiro statement
    assert.match(src, /\$r\s*=\s*&\s*\{\s*\$\{command\}\s*\}/, 'deve envolver $r = & { ${command} }');
});

test('REGRESSÃO: pshost.js força UTF-8 no [Console]::OutputEncoding', () => {
    const src = root('core/pshost.js');
    assert.match(src, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
    assert.match(src, /\$OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
});

test('REGRESSÃO: pshost.js NÃO usa setEncoding(utf8) no stdout (lê Buffer)', () => {
    const src = root('core/pshost.js');
    // setEncoding('utf8') quebrava porque PowerShell escrevia UTF-16 antes do preamble rodar.
    assert.doesNotMatch(src, /stdout\.setEncoding\(['"]utf8['"]\)/, 'não pode usar setEncoding(utf8) no stdout');
    // Deve decodificar manualmente via Buffer
    assert.match(src, /toString\(['"]utf8['"]\)/, 'deve decodificar Buffer→string manualmente');
});

test('REGRESSÃO: pshost.js tem handshake READY antes de aceitar comandos', () => {
    const src = root('core/pshost.js');
    assert.match(src, /PS_HOST_READY_V1/, 'deve ter marker de handshake READY');
    assert.match(src, /waitReady/, 'deve expor waitReady()');
    assert.match(src, /if\s*\(!this\.ready\)\s*await\s+this\.waitReady\(\)/, 'run() deve esperar READY');
});

test('REGRESSÃO: socket.js tem polling adaptativo (não polling de jobs quando SUBSCRIBED)', () => {
    const src = root('core/socket.js');
    assert.match(src, /watchdog/i, 'deve ter modo watchdog');
    assert.match(src, /WATCHDOG_MS/, 'deve ter constante de intervalo watchdog');
    // Quando SUBSCRIBED, NÃO deve buscar jobs (só verificar status)
    assert.match(src, /kind === ['"]watchdog['"]/, 'deve diferenciar modos');
});

test('REGRESSÃO: agent.js carrega preamble do PSHost no boot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /pshost\.setPreamble\(printerUSB\.PREAMBLE\)/, 'deve carregar preamble do RawPrinterHelper');
    assert.match(src, /pshost\.start\(\)/, 'deve iniciar PSHost no boot');
});

test('REGRESSÃO: agent.js usa heartbeat 60s (não 30s)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    // Procuramos exatamente o setInterval do heartbeat com 60000
    assert.match(src, /setInterval\(\(\)\s*=>\s*database\.sendHeartbeat\(\),\s*60000\)/);
    assert.doesNotMatch(src, /setInterval\(\(\)\s*=>\s*database\.sendHeartbeat\(\),\s*30000\)/);
});

test('REGRESSÃO: agent.js faz diff no IPC do tray (não envia se igual)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /lastPayloadJson/, 'deve guardar payload anterior');
    assert.match(src, /if\s*\(json\s*!==\s*lastPayloadJson\)/, 'deve comparar antes de enviar');
});

test('REGRESSÃO: agent.js trata DEVICE_CHANGE via IPC', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]DEVICE_CHANGE['"]/, 'deve responder ao DEVICE_CHANGE');
    assert.match(src, /monitor\.onDeviceChange/, 'deve chamar monitor.onDeviceChange');
});

test('REGRESSÃO: main.js registra WM_DEVICECHANGE (0x0219)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /WM_DEVICECHANGE\s*=\s*0x0219/, 'deve registrar mensagem WM_DEVICECHANGE');
    assert.match(src, /hookWindowMessage/, 'deve usar hookWindowMessage');
});

test('REGRESSÃO: main.js cria spooler offscreen + throttled', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /offscreen:\s*true/, 'spooler deve ser offscreen');
    assert.match(src, /backgroundThrottling:\s*true/, 'spooler deve ter backgroundThrottling');
    assert.match(src, /width:\s*400,\s*height:\s*800/, 'spooler 400x800 (reduzido de 800x600)');
});

test('REGRESSÃO: controllers.js tem cache de 30s em /api/printers', () => {
    const src = root('api/controllers.js');
    assert.match(src, /PRINTERS_CACHE_TTL_MS/, 'deve declarar TTL de cache');
    assert.match(src, /printersCache/, 'deve manter cache');
});

test('REGRESSÃO: controllers.js expõe /api/health enriquecido', () => {
    const src = root('api/controllers.js');
    assert.match(src, /authenticated:\s*state\.isAuthenticated\(\)/);
    assert.match(src, /printerConfigured/);
    assert.match(src, /defaultPrinter/);
    assert.match(src, /printerOnline/);
});

test('REGRESSÃO: server.js usa Controllers.health (não inline)', () => {
    const src = root('api/server.js');
    assert.match(src, /app\.get\(['"]\/api\/health['"],\s*Controllers\.health\)/);
});

test('REGRESSÃO: logger.js tem buffer reduzido para 100', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'logger.js'), 'utf8');
    assert.match(src, /MAX_BUFFER_SIZE\s*=\s*100/);
});

test('REGRESSÃO: fixQueue protege Resume-Printer com Get-Command (cmdlet pode não existir)', () => {
    const src = root('services/printerUSB.js');
    // Resume-Printer não está em todas as instalações do Windows. Tem que existir
    // um Get-Command (verificação de existência) ou estar dentro de um try/catch.
    assert.match(src, /Get-Command Resume-Printer/, 'fixQueue deve verificar existência via Get-Command');
    assert.match(src, /WorkOffline\s*=\s*\$false/, 'fixQueue deve ter fallback WMI para tirar do offline');
});

test('REGRESSÃO: fixQueue tem try/catch ao redor de operações de spooler', () => {
    const src = root('services/printerUSB.js');
    const fnMatch = src.match(/async fixQueue[\s\S]*?(?=\n    async |\n\}\s*\n)/);
    assert.ok(fnMatch, 'bloco fixQueue precisa ser localizável');
    const fn = fnMatch[0];
    // Deve ter pelo menos 3 try{}catch{} blocks (Get-PrintJob, Remove-PrintJob, Resume-Printer)
    const tryBlocks = (fn.match(/try\s*\{/g) || []).length;
    assert.ok(tryBlocks >= 3, `fixQueue deve ter ≥3 blocos try (achei ${tryBlocks})`);
});

test('REGRESSÃO: package.json está em 3.7.1', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.version, '3.7.1');
});

test('REGRESSÃO: controllers.js reporta version 3.7.1 em /api/health', () => {
    const src = root('api/controllers.js');
    assert.match(src, /version:\s*['"]3\.7\.1['"]/);
});

// ── UX profissional de update (v3.7.1+) ──────────────────────────────────────
test('UPDATE-UX: main.js usa autoDownload=false e autoInstallOnAppQuit=false (controle manual)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /autoUpdater\.autoDownload\s*=\s*false/);
    assert.match(src, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
});

test('UPDATE-UX: main.js persiste skipped versions em update-prefs.json', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /UPDATE_PREFS_FILE/);
    assert.match(src, /skippedVersions/);
    assert.match(src, /writeUpdatePrefs/);
    assert.match(src, /readUpdatePrefs/);
});

test('UPDATE-UX: main.js expõe ações actionCheckForUpdates/Download/InstallNow/SkipVersion', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /function\s+actionCheckForUpdates/);
    assert.match(src, /function\s+actionStartDownload/);
    assert.match(src, /function\s+actionInstallNow/);
    assert.match(src, /function\s+actionSkipVersion/);
});

test('UPDATE-UX: main.js trata IPC UPDATE_ACTION com requestId/respond', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]UPDATE_ACTION['"]/);
    assert.match(src, /UPDATE_ACTION_RESULT/);
});

test('UPDATE-UX: main.js NÃO baixa automaticamente em update-available', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const listener = src.match(/autoUpdater\.on\(['"]update-available['"][\s\S]*?\}\);/);
    assert.ok(listener);
    // O status deve ir para 'available' (esperando ação), NÃO direto para 'downloading'
    assert.match(listener[0], /status\s*=\s*['"]available['"]/);
    assert.doesNotMatch(listener[0], /autoUpdater\.downloadUpdate\(\)/);
});

test('UPDATE-UX: main.js respeita skippedVersions em update-available', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const listener = src.match(/autoUpdater\.on\(['"]update-available['"][\s\S]*?\}\);/);
    assert.match(listener[0], /skippedVersions\.includes/);
});

test('UPDATE-UX: agent.js expõe global.requestUpdateAction (ponte para REST)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.requestUpdateAction\s*=/);
    assert.match(src, /updateActionWaiters/);
    assert.match(src, /UPDATE_ACTION_RESULT/);
});

test('UPDATE-UX: controllers.js tem updateStatus/Check/Download/Install/Skip', () => {
    const src = root('api/controllers.js');
    assert.match(src, /updateStatus:\s*async/);
    assert.match(src, /updateCheck:\s*async/);
    assert.match(src, /updateDownload:\s*async/);
    assert.match(src, /updateInstall:\s*async/);
    assert.match(src, /updateSkip:\s*async/);
});

test('UPDATE-UX: server.js registra rotas REST de update', () => {
    const src = root('api/server.js');
    assert.match(src, /app\.get\(['"]\/api\/update['"],\s*Controllers\.updateStatus\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/check['"],\s*Controllers\.updateCheck\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/download['"],\s*Controllers\.updateDownload\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/install['"],\s*Controllers\.updateInstall\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/skip['"],\s*Controllers\.updateSkip\)/);
});

test('UPDATE-UX: public/index.html tem updateBanner com 4 estados (available/downloading/ready/error)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(src, /id="updateBanner"/);
    assert.match(src, /id="updateBannerActions"/);
    assert.match(src, /\.update-banner\.ready/);
    assert.match(src, /\.update-banner\.downloading/);
    assert.match(src, /\.update-banner\.error/);
});

test('UPDATE-UX: dashboard.js faz polling de /api/update e renderiza banner', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /pollUpdateStatus/);
    assert.match(src, /renderUpdateBanner/);
    assert.match(src, /function updateAction/);
    assert.match(src, /\/api\/update\//);
});

test('UPDATE-UX: tray menu mostra opções baseadas em status (available/downloading/ready)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /Nova versão.*disponível/);
    assert.match(src, /Baixar agora/);
    assert.match(src, /Pular esta versão/);
    assert.match(src, /Instalar e reiniciar/);
});

// ── Auto-update (v3.7.0+) ────────────────────────────────────────────────────
test('AUTOUPDATE: package.json declara electron-updater como dependência', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater deve estar em dependencies');
});

test('AUTOUPDATE: package.json configura publish provider github', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.build.publish) && pkg.build.publish.length > 0);
    const provider = pkg.build.publish[0];
    assert.equal(provider.provider, 'github');
    assert.ok(provider.owner, 'owner deve estar definido');
    assert.ok(provider.repo, 'repo deve estar definido');
});

test('AUTOUPDATE: package.json tem script release com publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pkg.scripts.release, /electron-builder.*--publish/);
    assert.equal(pkg.scripts.prerelease, 'npm test', 'prerelease deve rodar testes antes do publish');
});

test('AUTOUPDATE: main.js importa autoUpdater do electron-updater', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /require\(['"]electron-updater['"]\)/);
    assert.match(src, /autoUpdater\.checkForUpdates/);
});

test('AUTOUPDATE: main.js só checa updates se app.isPackaged (não em dev)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /if\s*\(app\.isPackaged\)/);
});

test('AUTOUPDATE: main.js tem listeners para update-available/downloaded/error', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /autoUpdater\.on\(['"]update-available['"]/);
    assert.match(src, /autoUpdater\.on\(['"]update-downloaded['"]/);
    assert.match(src, /autoUpdater\.on\(['"]error['"]/);
});

test('AUTOUPDATE: workflow GitHub Actions existe e tem permissões corretas', () => {
    const ymlPath = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');
    assert.ok(fs.existsSync(ymlPath), 'release.yml deve existir');
    const src = fs.readFileSync(ymlPath, 'utf8');
    assert.match(src, /windows-latest/, 'deve buildar em windows-latest');
    assert.match(src, /tags:\s*\n\s*-\s*['"]v\*['"]/, 'deve disparar em tag v*');
    assert.match(src, /contents:\s*write/, 'deve ter permission contents:write para criar release');
    assert.match(src, /npm\s+test/, 'workflow deve rodar npm test');
    assert.match(src, /npm\s+run\s+release/, 'workflow deve rodar npm run release');
    assert.match(src, /secrets\.GITHUB_TOKEN/, 'deve passar GH_TOKEN/GITHUB_TOKEN');
});

test('AUTOUPDATE: .gitignore protege artefatos sensíveis (data/, dist/, *.exe, .secure)', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.match(gitignore, /^data\/$/m);
    assert.match(gitignore, /^dist\/$/m);
    assert.match(gitignore, /\.exe/);
    assert.match(gitignore, /session\.secure/);
    assert.match(gitignore, /credentials\.secure/);
});

test('AUTOUPDATE: state.js inicializa updateStatus para o /api/health expor', () => {
    const src = root('config/state.js');
    assert.match(src, /this\.updateStatus\s*=/);
});

test('AUTOUPDATE: agent.js trata IPC UPDATE_STATUS vindo do main.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]UPDATE_STATUS['"]/);
    assert.match(src, /state\.updateStatus\s*=/);
});

// ── WebSocket realtime (v3.6.0+) ─────────────────────────────────────────────
test('REALTIME: wsBroadcast.js existe e exporta attach/broadcast/getClientCount', () => {
    const src = root('core/wsBroadcast.js');
    assert.match(src, /function\s+attach/);
    assert.match(src, /function\s+broadcast/);
    assert.match(src, /function\s+getClientCount/);
    assert.match(src, /WebSocketServer/);
    assert.match(src, /path:\s*['"]\/ws['"]/);
});

test('REALTIME: server.js usa http.createServer e acopla wsBroadcast', () => {
    const src = root('api/server.js');
    assert.match(src, /http\.createServer\(app\)/);
    assert.match(src, /wsBroadcast\.attach\(httpServer/);
});

test('REALTIME: saveConfig broadcastia config-changed e refaz monitor imediato', () => {
    const src = root('api/controllers.js');
    const fnMatch = src.match(/saveConfig:\s*async[\s\S]*?(?=\n    \/\/ Rota:|\n\};)/);
    assert.ok(fnMatch, 'bloco saveConfig precisa ser localizável');
    const fn = fnMatch[0];
    assert.match(fn, /wsBroadcast\.broadcast\(['"]config-changed['"]/);
    assert.match(fn, /monitor\.onDeviceChange\(['"]config-changed['"]\)/);
});

test('REALTIME: monitor publica status-update em diff (sem polling vazio)', () => {
    const src = root('services/monitor.js');
    assert.match(src, /_publishIfChanged/);
    assert.match(src, /_lastPublishedJson/);
    assert.match(src, /wsBroadcast\.broadcast\(['"]status-update['"]/);
});

// ── Batch enfileirado no agent (v3.6.0+) ─────────────────────────────────────
test('BATCH: agent.js expõe global.enqueueLocalJob (reusa jobQueue)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.enqueueLocalJob\s*=/, 'agent.js deve expor enqueueLocalJob');
    assert.match(src, /jobQueue\.push/, 'enqueueLocalJob deve usar jobQueue');
    assert.match(src, /runQueue\(\)/, 'enqueueLocalJob deve disparar runQueue');
});

test('BATCH: processJob skipa updateJobStatus para jobs locais (não existem no banco)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    // Agora é isLocalJob (cobre local-batch E local-single)
    assert.match(src, /isLocalJob\s*=\s*source\s*===\s*['"]local-batch['"]\s*\|\|\s*source\s*===\s*['"]local-single['"]/);
    // updateJobStatus de processing/printed/error deve estar dentro de if(!isLocalJob)
    assert.match(src, /if\s*\(!isLocalJob\)\s*\{\s*await\s+database\.updateJobStatus/);
});

test('BATCH: processJob broadcastia job-progress (printed e error)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /broadcast\(['"]job-progress['"],\s*\{[^}]*status:\s*['"]printed['"]/);
    assert.match(src, /broadcast\(['"]job-progress['"],\s*\{[^}]*status:\s*['"]error['"]/);
});

test('BATCH: controller localPrintBatch existe e usa global.enqueueLocalJob', () => {
    const src = root('api/controllers.js');
    assert.match(src, /localPrintBatch:\s*async/);
    assert.match(src, /global\.enqueueLocalJob/);
    assert.match(src, /source:\s*['"]local-batch['"]/);
});

test('BATCH: server.js registra rota POST /api/local-print-batch', () => {
    const src = root('api/server.js');
    assert.match(src, /app\.post\(['"]\/api\/local-print-batch['"],\s*Controllers\.localPrintBatch\)/);
});

// ── Stats centralizadas (v3.6.0+) ────────────────────────────────────────────
// Antes os incrementos viviam dentro de cada service (USB/Network/PDF) e o caminho
// HTML — usado por TODOS os recibos OnTrack — não era contado. Agora tudo é
// centralizado no processJob em agent.js.

test('STATS: agent.js processJob incrementa totalJobs no início', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch, 'bloco processJob precisa ser localizável');
    assert.match(fnMatch[0], /state\.stats\.totalJobs\+\+/);
});

test('STATS: agent.js processJob incrementa successJobs e lastJobTime no sucesso', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /state\.stats\.successJobs\+\+/);
    assert.match(fnMatch[0], /state\.stats\.lastJobTime\s*=\s*new Date\(\)/);
});

test('STATS: agent.js processJob incrementa failedJobs no catch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    // Procuramos por catch(...) seguido de failedJobs++ na mesma função
    assert.match(fnMatch[0], /catch\s*\(\s*e\s*\)\s*\{[\s\S]*?state\.stats\.failedJobs\+\+/);
});

test('STATS: printerUSB.js NÃO escreve mais em state.stats (centralizado em agent.js)', () => {
    const src = root('services/printerUSB.js');
    assert.doesNotMatch(src, /state\.stats\.successJobs/, 'printerUSB não pode incrementar successJobs');
    assert.doesNotMatch(src, /state\.stats\.failedJobs/, 'printerUSB não pode incrementar failedJobs');
    assert.doesNotMatch(src, /state\.stats\.lastJobTime/, 'printerUSB não pode setar lastJobTime');
});

test('STATS: printerNetwork.js NÃO escreve mais em state.stats', () => {
    const src = root('services/printerNetwork.js');
    assert.doesNotMatch(src, /state\.stats\.successJobs/);
    assert.doesNotMatch(src, /state\.stats\.failedJobs/);
    assert.doesNotMatch(src, /state\.stats\.lastJobTime/);
});

test('STATS: printerPDF.js NÃO escreve mais em state.stats', () => {
    const src = root('services/printerPDF.js');
    assert.doesNotMatch(src, /state\.stats\.successJobs/);
    assert.doesNotMatch(src, /state\.stats\.failedJobs/);
});

// ── /api/local-print agora passa pela fila (para contar stats + ordem) ───────
test('STATS: agent.js expõe global.jobEmitter (EventEmitter para waiters)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.jobEmitter\s*=/, 'agent.js deve expor global.jobEmitter');
    assert.match(src, /EventEmitter/);
});

test('STATS: processJob emite `done:<id>` em sucesso e falha', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    const fn = fnMatch[0];
    // Conta emissões dentro do try (sucesso) e do catch (falha) — pelo menos 2 ocorrências
    const occurrences = (fn.match(/jobEmitter\.emit\(`done:\$\{id\}`/g) || []).length;
    assert.ok(occurrences >= 2, `esperado ≥2 emissões done:<id>, achei ${occurrences}`);
});

test('STATS: /api/local-print usa enqueueLocalJob (passa pela fila) e aguarda jobEmitter', () => {
    const src = root('api/controllers.js');
    const fnMatch = src.match(/localPrint:\s*async[\s\S]*?(?=\n    \/\/ Rota:|\n    [a-zA-Z]+:|\n\};)/);
    assert.ok(fnMatch, 'bloco localPrint precisa ser localizável');
    const fn = fnMatch[0];
    assert.match(fn, /global\.enqueueLocalJob/, 'localPrint deve enfileirar pelo mesmo caminho do batch');
    assert.match(fn, /global\.jobEmitter\.once\(`done:\$\{id\}`/, 'localPrint deve aguardar done:<id>');
    assert.match(fn, /source:\s*['"]local-single['"]/, 'job deve marcar source=local-single');
    // E NÃO pode mais chamar global.requestHtmlPrint diretamente (caminho antigo que pulava stats)
    assert.doesNotMatch(fn, /global\.requestHtmlPrint/, 'localPrint não pode mais bypassar a queue');
});

test('STATS: processJob trata local-batch E local-single como local (sem DB)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /source\s*===\s*['"]local-batch['"]\s*\|\|\s*source\s*===\s*['"]local-single['"]/);
});

// ── Validação de impressora — anti default-printer-fallback (v3.6.0+) ────────
// O Electron usa a impressora PADRÃO do Windows se deviceName for vazio. Em
// ambientes compartilhados isso pode imprimir em uma impressora de outro setor.
// Aqui validamos que NENHUM caminho permite que isso aconteça.

test('SAFETY: utils/printerValidator.js existe e exporta isValidPrinterName + safePrinterName', () => {
    const src = root('utils/printerValidator.js');
    assert.match(src, /function\s+isValidPrinterName/);
    assert.match(src, /function\s+safePrinterName/);
    assert.match(src, /module\.exports\s*=\s*\{[^}]*isValidPrinterName[^}]*safePrinterName/);
});

test('SAFETY: main.js valida deviceName em spooler-ready-to-print', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /isValidPrinterName/, 'main.js deve importar isValidPrinterName');
    // E deve usar antes do webContents.print real (note: \( para casar chamada, não comentário)
    const handler = src.match(/ipcMain\.on\(['"]spooler-ready-to-print['"][\s\S]*?persistentSpoolerWindow\.webContents\.print\(/);
    assert.ok(handler, 'handler spooler-ready-to-print precisa ser localizável');
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: main.js valida deviceName em PRINT_HTML antes do spooler', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const handler = src.match(/msg\.type\s*===\s*['"]PRINT_HTML['"][\s\S]*?persistentSpoolerWindow\.webContents\.send\(/);
    assert.ok(handler);
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: main.js valida deviceName em PRINT_TEST_LABEL antes de criar BrowserWindow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const handler = src.match(/msg\.type\s*===\s*['"]PRINT_TEST_LABEL['"][\s\S]*?new BrowserWindow\(\{/);
    assert.ok(handler);
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: agent.js processJob (branch html) rejeita nome vazio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    const fn = fnMatch[0];
    // No branch html, deve usar safePrinterName + throw se null
    const htmlBranch = fn.match(/job_type === ['"]html['"][\s\S]*?else \{/);
    assert.ok(htmlBranch, 'branch html precisa ser localizável');
    assert.match(htmlBranch[0], /safePrinterName/);
    assert.match(htmlBranch[0], /throw new Error/);
});

test('SAFETY: agent.js processJob (branch pdf) rejeita nome vazio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/job_type === ['"]pdf['"][\s\S]*?job_type === ['"]html['"]/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /safePrinterName/);
    assert.match(fnMatch[0], /throw new Error/);
});

test('SAFETY: agent.js requestHtmlPrint/requestTestPrint rejeitam nome inválido', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnHtml = src.match(/function requestHtmlPrint[\s\S]*?^}/m);
    const fnTest = src.match(/function requestTestPrint[\s\S]*?^}/m);
    assert.ok(fnHtml && fnTest);
    assert.match(fnHtml[0], /isValidPrinterName\(printerName\)/);
    assert.match(fnTest[0], /isValidPrinterName\(printerName\)/);
});

test('SAFETY: controllers.js usa safePrinterName em localPrint/localPrintBatch/testPrint', () => {
    const src = root('api/controllers.js');
    // Conta ocorrências de safePrinterName — esperamos pelo menos 3
    const matches = src.match(/safePrinterName\s*\(/g) || [];
    assert.ok(matches.length >= 3, `esperado ≥3 usos de safePrinterName, achei ${matches.length}`);
});

// ── Impressão direta (bypass do banco) ──────────────────────────────────────
// Esse fluxo permite ao PWA mandar HTML direto para a impressora local sem
// passar por PDF → Supabase Storage → download → SumatraPDF → delete. É o caminho
// rápido usado pelo PrintOrchestrator quando detecta agente local rodando.

test('FLUXO RÁPIDO: /api/local-print existe e aceita HTML direto', () => {
    const ctrl = root('api/controllers.js');
    const srv = root('api/server.js');
    assert.match(ctrl, /localPrint:\s*async/, 'controller localPrint precisa existir');
    assert.match(srv, /app\.post\(['"]\/api\/local-print['"],\s*Controllers\.localPrint\)/, 'rota POST /api/local-print precisa estar registrada');
});

test('FLUXO RÁPIDO: localPrint NÃO usa Supabase Storage/SumatraPDF (caminho rápido)', () => {
    const ctrl = root('api/controllers.js');
    const fnMatch = ctrl.match(/localPrint:\s*async[\s\S]*?(?=\n    \/\/ Rota:|\n    [a-zA-Z]+:|\n\};)/);
    assert.ok(fnMatch, 'bloco localPrint precisa ser localizável');
    const fn = fnMatch[0];
    assert.doesNotMatch(fn, /storage\s*\.\s*from\(/i, 'caminho rápido não pode usar Supabase Storage');
    assert.doesNotMatch(fn, /SumatraPDF/i, 'caminho rápido não pode usar SumatraPDF');
});

test('FLUXO RÁPIDO: main.js processa IPC PRINT_HTML (recebido do processJob no branch html)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /type:\s*['"]PRINT_HTML['"]/, 'agent.js deve enviar IPC PRINT_HTML em algum lugar');
});

test('FLUXO RÁPIDO: main.js processa PRINT_HTML e envia ao spooler persistente', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]PRINT_HTML['"]/, 'main.js deve tratar PRINT_HTML');
    assert.match(src, /persistentSpoolerWindow\.webContents\.send\(['"]inject-html-for-print['"]/,
        'main.js deve injetar HTML no spooler offscreen');
});

// Esses dois testes leem arquivos do FRONTEND (my-app/src/lib/print/*) que
// vivem em outro repo. Em CI isolado (apenas o Printer-Agent), os paths não
// existem — pulamos elegantemente com test.skip nesses casos.
const FRONTEND_ORCH = path.join(__dirname, '..', '..', 'src', 'lib', 'print', 'printOrchestrator.ts');
const FRONTEND_CLIENT = path.join(__dirname, '..', '..', 'src', 'lib', 'print', 'localAgentClient.ts');
const hasFrontendSources = fs.existsSync(FRONTEND_ORCH) && fs.existsSync(FRONTEND_CLIENT);

test('FLUXO RÁPIDO: frontend (printOrchestrator) usa printDirectly E sendToCloudQueue', { skip: !hasFrontendSources && 'frontend sources não disponíveis (CI isolado)' }, () => {
    const orch = fs.readFileSync(FRONTEND_ORCH, 'utf8');
    assert.match(orch, /LocalAgentClient\.printDirectly/, 'orchestrator deve tentar printDirectly');
    assert.match(orch, /sendToCloudQueue/, 'orchestrator deve ter caminho da fila como fallback');
});

test('FLUXO RÁPIDO: localAgentClient envia para POST /api/local-print', { skip: !hasFrontendSources && 'frontend sources não disponíveis (CI isolado)' }, () => {
    const src = fs.readFileSync(FRONTEND_CLIENT, 'utf8');
    assert.match(src, /\/api\/local-print/, 'cliente deve apontar para /api/local-print');
    assert.match(src, /method:\s*['"]POST['"]/, 'deve usar método POST');
});
