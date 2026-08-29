const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");
const { BrowserWindow } = require("electron");

const PRINT_LOAD_TIMEOUT_MS = 30_000;
const PRINT_JOB_TIMEOUT_MS = 180_000;

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Una foto por pagina, sin margenes: el papel lo elige el operador en el
// dialogo nativo de Windows, asi que la imagen solo se ajusta al alto/ancho
// disponible sin deformarse.
function buildPrintDocumentHtml(photoPaths) {
  const pages = photoPaths
    .map((photoPath, index) => {
      const href = escapeHtmlAttribute(pathToFileURL(photoPath).href);
      return `    <div class="print-page"><img src="${href}" alt="Foto ${index + 1}" /></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Fotos para imprimir</title>
    <style>
      @page { margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .print-page {
        width: 100vw;
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        break-after: page;
        page-break-after: always;
      }
      .print-page:last-child { break-after: auto; page-break-after: auto; }
      .print-page img { max-width: 100%; max-height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
${pages}
  </body>
</html>
`;
}

function waitForLoad(printWindow) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(new Error("La preparacion de las fotos para imprimir tardo demasiado."));
    }, PRINT_LOAD_TIMEOUT_MS);

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      printWindow.webContents.removeListener("did-finish-load", onFinishLoad);
      printWindow.webContents.removeListener("did-fail-load", onFailLoad);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onFinishLoad() {
      finish(null);
    }

    function onFailLoad(_event, errorCode, errorDescription) {
      finish(new Error(`No se pudo preparar el documento (${errorCode}): ${errorDescription}`));
    }

    printWindow.webContents.on("did-finish-load", onFinishLoad);
    printWindow.webContents.on("did-fail-load", onFailLoad);
  });
}

async function countBrokenImages(printWindow) {
  const broken = await printWindow.webContents.executeJavaScript(
    "Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length",
    true
  );
  return Number(broken) || 0;
}

function runPrintJob(printWindow) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("La impresora no respondio a tiempo."));
    }, PRINT_JOB_TIMEOUT_MS);

    printWindow.webContents.print(
      {
        silent: false,
        printBackground: true
      },
      (success, failureReason) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);

        if (success) {
          resolve({ printed: true, cancelled: false });
          return;
        }
        // Electron devuelve "cancelled" cuando el operador cierra el dialogo:
        // no es un error, es una decision.
        if (String(failureReason || "").toLowerCase().includes("cancel")) {
          resolve({ printed: false, cancelled: true });
          return;
        }
        reject(new Error(failureReason || "La impresion fallo sin motivo informado."));
      }
    );
  });
}

async function printPhotos({ photoPaths, parentWindow = null } = {}) {
  const paths = Array.isArray(photoPaths) ? photoPaths.filter(Boolean) : [];
  if (paths.length === 0) {
    throw new Error("No hay fotos para imprimir.");
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifibav3-print-"));
  const documentPath = path.join(workDir, "print.html");
  fs.writeFileSync(documentPath, buildPrintDocumentHtml(paths), "utf8");

  const printWindow = new BrowserWindow({
    show: false,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    printWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // El waiter se engancha antes de disparar la carga: si esperamos a que
    // loadFile() resuelva, did-finish-load ya se disparo y el listener nunca
    // se entera, asi que la impresion moria por timeout sin abrir el dialogo.
    const loaded = waitForLoad(printWindow);
    await Promise.all([
      // loadFile rechaza ante un fallo de carga; el motivo real lo informa
      // did-fail-load a traves del waiter, con mensaje para el operador.
      printWindow.loadFile(documentPath).catch(() => undefined),
      loaded
    ]);

    const brokenImages = await countBrokenImages(printWindow);
    if (brokenImages >= paths.length) {
      throw new Error("Ninguna de las fotos seleccionadas se pudo cargar para imprimir.");
    }

    const result = await runPrintJob(printWindow);
    return { ...result, pages: paths.length, brokenImages };
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
    fs.rm(workDir, { recursive: true, force: true }, () => undefined);
  }
}

module.exports = { printPhotos, buildPrintDocumentHtml };
