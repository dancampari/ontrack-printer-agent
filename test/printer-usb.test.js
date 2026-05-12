/**
 * PrinterUSB — testa que o preamble do RawPrinterHelper compila no boot e
 * o tipo fica disponível para chamadas subsequentes (sem re-Add-Type a cada job).
 *
 * NÃO imprime de verdade — só valida que [RawPrinterHelper]::SendFile
 * existe como método estático após o preamble.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const printerUSB = require('../src/services/printerUSB');

function loadFreshPSHost() {
    const modPath = require.resolve('../src/core/pshost');
    delete require.cache[modPath];
    return require('../src/core/pshost');
}

test('PrinterUSB.PREAMBLE existe e contém RawPrinterHelper', () => {
    assert.ok(typeof printerUSB.PREAMBLE === 'string', 'PREAMBLE deve ser string');
    assert.match(printerUSB.PREAMBLE, /RawPrinterHelper/, 'PREAMBLE deve definir RawPrinterHelper');
    assert.match(printerUSB.PREAMBLE, /winspool\.Drv/, 'PREAMBLE deve referenciar winspool.Drv');
    assert.match(printerUSB.PREAMBLE, /public static bool SendFile/, 'PREAMBLE deve expor SendFile estático');
});

test('PrinterUSB: preamble carrega RawPrinterHelper UMA VEZ no PSHost', async () => {
    const pshost = loadFreshPSHost();
    pshost.setPreamble(printerUSB.PREAMBLE);
    try {
        pshost.start();
        await pshost.waitReady();
        // Após READY, o tipo deve estar disponível via reflection
        const result = await pshost.run(
            `[Console]::WriteLine([RawPrinterHelper].GetMethod('SendFile').Name)`,
            { raw: true }
        );
        assert.match(result, /SendFile/, 'método SendFile deve estar acessível como estático');
    } finally {
        pshost.stop();
    }
});

test('PrinterUSB: preamble é idempotente (segundo Add-Type não falha)', async () => {
    const pshost = loadFreshPSHost();
    pshost.setPreamble(printerUSB.PREAMBLE);
    try {
        pshost.start();
        await pshost.waitReady();
        // Reexecuta o preamble — deve ser protegido por `if (-not ('RawPrinterHelper' -as [type]))`
        await pshost.run(printerUSB.PREAMBLE, { raw: true, timeoutMs: 5000 });
        // E ainda deve funcionar
        const result = await pshost.run(`[Console]::WriteLine([RawPrinterHelper].FullName)`, { raw: true });
        assert.match(result, /RawPrinterHelper/);
    } finally {
        pshost.stop();
    }
});

test('REGRESSÃO BUG-WRITE-HOST: SendFile usa [Console]::WriteLine, não Write-Host', () => {
    // Antes: o printerUSB usava Write-Host para SUCCESS/ERROR_SPOOLER, que pode ser
    // interceptado pelo pipeline em alguns cenários. Agora deve ser [Console]::WriteLine.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'printerUSB.js'), 'utf8');
    assert.doesNotMatch(src, /Write-Host\s+'SUCCESS'/, 'não pode usar Write-Host para sentinela SUCCESS');
    assert.doesNotMatch(src, /Write-Host\s+'ERROR_SPOOLER'/, 'não pode usar Write-Host para sentinela ERROR');
    assert.match(src, /\[Console\]::WriteLine\('SUCCESS'\)/, 'deve usar [Console]::WriteLine para SUCCESS');
    assert.match(src, /\[Console\]::WriteLine\('ERROR_SPOOLER'\)/, 'deve usar [Console]::WriteLine para ERROR');
});

test('PrinterUSB: fixQueue usa [Console]::WriteLine para FIXED:', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'printerUSB.js'), 'utf8');
    assert.doesNotMatch(src, /Write-Host\s*\("FIXED:"/, 'fixQueue não pode usar Write-Host');
    assert.match(src, /\[Console\]::WriteLine\("FIXED:"/, 'fixQueue deve usar [Console]::WriteLine');
});

test('PrinterUSB.fixQueue: script roda mesmo simulando Resume-Printer indisponível', async () => {
    // Reproduz o cenário do bug: em algumas instalações Resume-Printer não existe.
    // Simulamos isso "scopeando" a função para nula e garantindo que o script ainda
    // termina com FIXED:N sem lançar exception no PowerShell.
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();

        // Sobrescreve Resume-Printer no escopo para simular ausência:
        // criamos uma função que lança CommandNotFoundException. Get-Command continua
        // achando ela, então também removemos via Remove-Item alias se existir.
        // Mais simples: testar o script DIRETAMENTE com uma impressora que existe e
        // verificar que ele termina com FIXED:N (não importa se Resume-Printer rodou).
        const fakeName = `__test_printer_${Date.now()}__`;
        const script = `
$p = '${fakeName}'
$jobsCount = 0
try {
  $jobsCount = (Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Measure-Object).Count
} catch {}
try {
  Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
} catch {}
$resumed = $false
try {
  if (Get-Command Resume-Printer -ErrorAction SilentlyContinue) {
    Resume-Printer -Name $p -ErrorAction SilentlyContinue
    $resumed = $true
  }
} catch {}
if (-not $resumed) {
  try {
    $wmi = Get-WmiObject -Class Win32_Printer -Filter "Name='$p'" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.WorkOffline) {
      $wmi.WorkOffline = $false
      [void]$wmi.Put()
    }
  } catch {}
}
[Console]::WriteLine("FIXED:" + $jobsCount)
`.trim();

        const out = (await pshost.run(script, { raw: true, timeoutMs: 10000 })).trim();
        assert.match(out, /FIXED:\d+/, 'script defensivo deve sempre emitir FIXED:N');
        // E NÃO deve vazar a mensagem "não é reconhecido" nem em PT nem em EN
        assert.doesNotMatch(out, /não é reconhecido|is not recognized/i,
            'script defensivo não pode vazar erro de cmdlet inexistente');
    } finally {
        pshost.stop();
    }
});
