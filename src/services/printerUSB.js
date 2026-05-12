const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const logger = require('../utils/logger');
const state = require('../config/state');
const pshost = require('../core/pshost');

/**
 * PrinterUSB — impressão raw (ZPL/ESC-POS) via Winspool API.
 *
 * Antes: cada job spawnava um powershell.exe e fazia `Add-Type` inline de um
 * helper C# de ~70 linhas (JIT compila + carrega ~30 MB a cada print).
 * Agora: o helper é carregado UMA vez via PSHost.setPreamble() no boot do agent.js,
 * e cada print só executa `[RawPrinterHelper]::SendFile(...)`.
 */

// Mesmo bloco C# de antes, mas movido para preamble único do PSHost.
// Exposto para o agent.js registrar uma vez no boot.
const RAW_PRINTER_HELPER_PREAMBLE = `
if (-not ('RawPrinterHelper' -as [type])) {
$code = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    public static bool SendFile(string printerName, string path) {
        if (!File.Exists(path)) return false;
        IntPtr hPrinter = new IntPtr(0);
        DOCINFOA di = new DOCINFOA { pDocName = "OnTrack Job", pDataType = "RAW" };
        bool success = false;
        if (OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
            try {
                if (StartDocPrinter(hPrinter, 1, di)) {
                    try {
                        if (StartPagePrinter(hPrinter)) {
                            byte[] bytes = File.ReadAllBytes(path);
                            IntPtr pBytes = Marshal.AllocHGlobal(bytes.Length);
                            try {
                                Marshal.Copy(bytes, 0, pBytes, bytes.Length);
                                Int32 dwWritten = 0;
                                success = WritePrinter(hPrinter, pBytes, bytes.Length, out dwWritten);
                            } finally { Marshal.FreeHGlobal(pBytes); }
                            EndPagePrinter(hPrinter);
                        }
                    } finally { EndDocPrinter(hPrinter); }
                }
            } finally { ClosePrinter(hPrinter); }
        }
        return success;
    }
}
'@
Add-Type -TypeDefinition $code
}
`.trim();

class PrinterUSB {
    async print(jobId, zplContent) {
        const printerName = state.currentConfig.printerName;
        if (!printerName) throw new Error('Nome da impressora USB não configurado');

        if (!/^[a-zA-Z0-9\s\-_\(\)\[\]\.]+$/.test(printerName)) {
            throw new Error(`Nome de impressora inválido: "${printerName}"`);
        }

        logger.info('PRINTER:USB', `Imprimindo em: ${printerName}`);

        let tempFilePath = '';
        try {
            // Detecta payload base64 (ESC/POS raw) vs ZPL textual
            let bufferData;
            let ext;
            if (zplContent.startsWith('[base64:]')) {
                bufferData = Buffer.from(zplContent.substring(9), 'base64');
                ext = 'bin';
            } else {
                bufferData = iconv.encode(zplContent, 'cp850');
                ext = 'zpl';
            }

            const stem = `ontrack_${jobId.substring(0, 8)}_${crypto.randomBytes(4).toString('hex')}`;
            tempFilePath = path.join(os.tmpdir(), `${stem}.${ext}`);
            fs.writeFileSync(tempFilePath, bufferData);

            const safeName = printerName.replace(/'/g, "''");
            const safePath = tempFilePath.replace(/'/g, "''");

            // RawPrinterHelper já está carregado no PSHost (via preamble registrado no boot).
            // Aqui só executamos a chamada estática.
            const out = (await pshost.run(
                `if ([RawPrinterHelper]::SendFile('${safeName}', '${safePath}')) { [Console]::WriteLine('SUCCESS') } else { [Console]::WriteLine('ERROR_SPOOLER') }`,
                { raw: true, timeoutMs: 15_000 }
            )).trim();

            if (out.includes('SUCCESS')) {
                logger.info('PRINTER:USB', `Job ${jobId} enviado ao spooler.`);
                return;
            }

            throw new Error(out || 'Falha desconhecida do spooler');
        } catch (e) {
            throw e;
        } finally {
            if (tempFilePath) {
                try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
            }
        }
    }

    async fixQueue(printerName) {
        if (!printerName) throw new Error('Nenhuma impressora configurada.');
        logger.info('PRINTER:USB', `Corrigindo fila de: ${printerName}`);

        // Cada operação é envolvida em try/catch porque:
        //  - Em algumas instalações o módulo PrintManagement (Resume-Printer,
        //    Get-Printer) não está disponível e o cmdlet inexiste; com
        //    -ErrorAction SilentlyContinue isso ainda quebra o script porque
        //    o erro é CommandNotFoundException (antes da avaliação do parâmetro).
        //  - Get-PrintJob/Remove-PrintJob podem falhar se o usuário não tem
        //    permissão de spooler.
        // Fallback via WMI cobre o "tirar do offline" quando Resume-Printer não existe.
        const safe = printerName.replace(/'/g, "''");
        const script = `
$p = '${safe}'
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

        const out = (await pshost.run(script, { raw: true, timeoutMs: 10_000 })).trim();
        const match = out.match(/FIXED:(\d+)/);
        if (match) {
            const n = parseInt(match[1], 10) || 0;
            logger.info('PRINTER:USB', `Fila corrigida. Removidos: ${n}`);
            return n;
        }
        throw new Error(`Falha ao limpar fila: ${out || 'sem resposta'}`);
    }
}

const instance = new PrinterUSB();
instance.PREAMBLE = RAW_PRINTER_HELPER_PREAMBLE;
module.exports = instance;
