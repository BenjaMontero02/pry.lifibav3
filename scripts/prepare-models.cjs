#!/usr/bin/env node
"use strict";

// Descarga y deja listos los modelos faciales declarados en scripts/models.json.
//
// Existe porque delegarle la descarga a insightface producia bundles rotos.
// `insightface.utils.storage.download()` hace `zf.extractall(models/antelopev2)`
// sobre un zip que YA trae una carpeta `antelopev2/` adentro, asi que los .onnx
// terminan un nivel mas abajo de donde FaceAnalysis los busca. El resultado es
// una excepcion sin mensaje y un directorio que existe pero esta vacio, que
// build.spec empaquetaba igual.
//
// Aca el zip se extrae APLANADO y despues se verifica la lista exacta de
// archivos esperados. Si upstream cambia la estructura, esto falla en vez de
// empaquetar basura.

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "models.json");
const MAX_REDIRECTS = 5;

function fail(message) {
  console.error(`[prepare-models] ERROR: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[prepare-models] ${message}`);
}

function resolveDestination(dest) {
  if (dest.startsWith("~/") || dest.startsWith("~\\")) {
    return path.join(os.homedir(), dest.slice(2));
  }
  return path.resolve(ROOT, dest);
}

function missingFiles(destDir, expectedFiles) {
  return expectedFiles.filter((name) => !fs.existsSync(path.join(destDir, name)));
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Descarga siguiendo redirects (los assets de Release de GitHub redirigen a S3).
function download(url, targetPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "user-agent": "lifibav3-prepare-models" } },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`demasiados redirects para ${url}`));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          download(nextUrl, targetPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status} al descargar ${url}`));
          return;
        }

        const total = Number(response.headers["content-length"] || 0);
        let received = 0;
        let lastReported = 0;

        const file = fs.createWriteStream(targetPath);
        response.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const percent = Math.floor((received / total) * 100);
            if (percent >= lastReported + 20) {
              lastReported = percent - (percent % 20);
              log(`  ${lastReported}% (${received} / ${total} bytes)`);
            }
          }
        });
        response.pipe(file);
        file.on("error", reject);
        file.on("finish", () => file.close(() => resolve(received)));
      }
    );
    request.on("error", reject);
  });
}

// Lector de zip minimo: parsea el directorio central y devuelve las entradas
// de archivo con su contenido descomprimido. Se usa el directorio central (no
// los local headers) porque es la unica fuente confiable de los tamanios
// cuando el zip fue escrito en streaming.
function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;

  let eocdOffset = -1;
  const scanFrom = Math.max(0, buffer.length - 66_000);
  for (let offset = buffer.length - 22; offset >= scanFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(`no se encontro el fin del directorio central en ${zipPath}`);
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`entrada ${index} del directorio central invalida en ${zipPath}`);
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith("/")) {
      let content;
      if (compressionMethod === 0) {
        content = raw;
      } else if (compressionMethod === 8) {
        content = zlib.inflateRawSync(raw);
      } else {
        throw new Error(`metodo de compresion ${compressionMethod} no soportado (${name})`);
      }
      entries.push({ name, content });
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// Escribe cada entrada en <destDir>/<basename>: aplana cualquier carpeta
// intermedia e ignora la metadata que agrega macOS al comprimir.
function extractFlattened(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let written = 0;

  for (const entry of readZipEntries(zipPath)) {
    const normalized = entry.name.replace(/\\/g, "/");
    if (normalized.startsWith("__MACOSX/")) {
      continue;
    }
    const baseName = path.posix.basename(normalized);
    if (!baseName || baseName.startsWith("._") || baseName === ".DS_Store") {
      continue;
    }
    fs.writeFileSync(path.join(destDir, baseName), entry.content);
    written += 1;
  }

  return written;
}

async function prepareModel(model) {
  const destDir = resolveDestination(model.dest);
  const stillMissing = missingFiles(destDir, model.expectedFiles);

  if (stillMissing.length === 0) {
    log(`${model.id}: ya presente en ${destDir}, se omite la descarga.`);
    return;
  }

  log(`${model.id}: faltan ${stillMissing.length} archivo(s). Descargando...`);
  log(`  ${model.url}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifiba-models-"));
  const downloadName =
    model.kind === "zip-flatten" ? `${model.id}.zip` : model.expectedFiles[0];
  const downloadPath = path.join(tempDir, downloadName);

  try {
    let received;
    try {
      received = await download(model.url, downloadPath);
    } catch (error) {
      fail(
        `no se pudo descargar ${model.id}: ${String(error.message || error)}. ` +
          `Origen: ${model.url}`
      );
    }

    if (model.bytes && received !== model.bytes) {
      fail(
        `${model.id} se descargo mal: se esperaban ${model.bytes} bytes y llegaron ${received}.`
      );
    }

    const digest = await sha256OfFile(downloadPath);
    if (digest !== model.sha256) {
      fail(
        `${model.id} se descargo mal: sha256 esperado ${model.sha256}, obtenido ${digest}. ` +
          "El origen cambio de contenido o la descarga se corrompio."
      );
    }
    log(`  sha256 verificado (${digest}).`);

    if (model.kind === "zip-flatten") {
      const written = extractFlattened(downloadPath, destDir);
      log(`  ${written} archivo(s) extraido(s) aplanados en ${destDir}.`);
    } else {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(downloadPath, path.join(destDir, model.expectedFiles[0]));
      log(`  copiado a ${destDir}.`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const afterMissing = missingFiles(destDir, model.expectedFiles);
  if (afterMissing.length > 0) {
    fail(
      `${model.id} quedo incompleto tras la preparacion. Faltan en ${destDir}: ` +
        `${afterMissing.join(", ")}. La estructura del origen puede haber cambiado.`
    );
  }
  log(`${model.id}: OK (${model.expectedFiles.length} archivo(s) verificado(s)).`);
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    fail(`no se pudo leer ${MANIFEST_PATH}: ${String(error.message || error)}`);
  }

  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    fail(`${MANIFEST_PATH} no declara modelos.`);
  }

  for (const model of manifest.models) {
    await prepareModel(model);
  }

  log("Todos los modelos estan listos para empaquetar.");
}

main().catch((error) => {
  fail(String(error && error.stack ? error.stack : error));
});
