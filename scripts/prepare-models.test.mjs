// Tests de las funciones puras de scripts/prepare-models.cjs: lector de zip
// (readZipEntries), extraccion aplanada (extractFlattened) y verificacion de
// sha256 (sha256OfFile). El zip fixture se genera en el propio test: no hace
// falta ningun modelo ni red.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { readZipEntries, extractFlattened, sha256OfFile } = require("./prepare-models.cjs");

// Arma un zip minimo (local headers + directorio central + EOCD). method 0 =
// stored, 8 = deflate. `dir` entries terminan en "/" y no llevan datos.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data
      ? entry.method === 8
        ? zlib.deflateRawSync(entry.data)
        : entry.data
      : Buffer.alloc(0);
    const data = entry.data || Buffer.alloc(0);
    const crc = entry.data ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, raw);
    centrals.push(central, name);
    offset += local.length + name.length + raw.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

describe("prepare-models: readZipEntries", () => {
  let workDir;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-models-test-"));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("devuelve archivos stored y deflated con su contenido, sin carpetas", () => {
    const zipPath = path.join(workDir, "mixed.zip");
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: "pack/", data: null },
        { name: "pack/stored.bin", data: Buffer.from("hola stored"), method: 0 },
        { name: "pack/deflated.onnx", data: Buffer.from("x".repeat(500)), method: 8 }
      ])
    );

    const entries = readZipEntries(zipPath);

    expect(entries.map((entry) => entry.name)).toEqual([
      "pack/stored.bin",
      "pack/deflated.onnx"
    ]);
    expect(entries[0].content.toString("utf8")).toBe("hola stored");
    expect(entries[1].content.equals(Buffer.from("x".repeat(500)))).toBe(true);
  });

  it("rechaza un archivo que no es zip", () => {
    const notZip = path.join(workDir, "not-a-zip.zip");
    fs.writeFileSync(notZip, Buffer.from("esto no es un zip, nada de nada"));

    expect(() => readZipEntries(notZip)).toThrow(/directorio central/);
  });
});

describe("prepare-models: extractFlattened", () => {
  let workDir;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-models-flat-"));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("aplana carpetas, ignora __MACOSX, ._* y .DS_Store", () => {
    const zipPath = path.join(workDir, "antelopev2.zip");
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: "antelopev2/", data: null },
        { name: "antelopev2/1k3d68.onnx", data: Buffer.from("modelo-a"), method: 8 },
        { name: "antelopev2/._1k3d68.onnx", data: Buffer.from("basura mac"), method: 0 },
        { name: "antelopev2/.DS_Store", data: Buffer.from("ds"), method: 0 },
        { name: "__MACOSX/antelopev2/._genderage.onnx", data: Buffer.from("meta"), method: 0 },
        { name: "antelopev2/anidada/scrfd_10g_bnkps.onnx", data: Buffer.from("modelo-b"), method: 0 }
      ])
    );

    const destDir = path.join(workDir, "out", "antelopev2");
    const written = extractFlattened(zipPath, destDir);

    expect(written).toBe(2);
    expect(fs.readdirSync(destDir).sort()).toEqual([
      "1k3d68.onnx",
      "scrfd_10g_bnkps.onnx"
    ]);
    expect(fs.readFileSync(path.join(destDir, "1k3d68.onnx"), "utf8")).toBe("modelo-a");
    expect(fs.readFileSync(path.join(destDir, "scrfd_10g_bnkps.onnx"), "utf8")).toBe(
      "modelo-b"
    );
  });
});

describe("prepare-models: sha256OfFile", () => {
  it("coincide con el sha256 calculado directamente sobre los bytes", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-models-sha-"));
    try {
      const filePath = path.join(workDir, "blob.bin");
      const payload = crypto.randomBytes(3 * 1024 * 1024 + 17);
      fs.writeFileSync(filePath, payload);

      const expected = crypto.createHash("sha256").update(payload).digest("hex");
      await expect(sha256OfFile(filePath)).resolves.toBe(expected);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("detecta un archivo alterado (el digest cambia)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-models-sha-"));
    try {
      const filePath = path.join(workDir, "blob.bin");
      fs.writeFileSync(filePath, "contenido original");
      const original = await sha256OfFile(filePath);

      fs.writeFileSync(filePath, "contenido alterado");
      await expect(sha256OfFile(filePath)).resolves.not.toBe(original);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
