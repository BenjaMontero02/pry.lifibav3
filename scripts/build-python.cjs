#!/usr/bin/env node
"use strict";

// Build multiplataforma del backend Python:
// - Corre PyInstaller sobre python/build.spec (modo onedir: COLLECT).
// - Copia el CONTENIDO completo de python/dist/python-child/ a resources/python/, de
//   modo que el ejecutable quede en resources/python/python-child(.exe) con su
//   carpeta _internal/ al lado. electron/python-bridge.js busca
//   process.resourcesPath/python/python-child.exe y no necesita cambios.
// Windows produce python-child.exe; macOS/Linux produce python-child.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const childBinary = isWindows ? "python-child.exe" : "python-child";
// PyInstaller escribe en python/dist/ y NO en dist/: dist/ es la salida de vite
// y electron-builder empaqueta dist/**/* dentro del asar. Si el onedir (~1 GB)
// cayera ahi, se colaria en la app.
const PYI_DIST = path.join(ROOT, "python", "dist");
const sourceDir = path.join(PYI_DIST, "python-child");
const outDir = path.join(ROOT, "resources", "python");
// Unico archivo versionado dentro de resources/python (ver .gitignore).
const KEEP = new Set([".gitkeep"]);

function fail(message) {
  console.error(`[build-python] ${message}`);
  process.exit(1);
}

console.log("[build-python] Building Python executable with PyInstaller...");
const build = spawnSync(
  "pyinstaller",
  ["--clean", "--noconfirm", "--distpath", PYI_DIST, path.join("python", "build.spec")],
  { cwd: ROOT, stdio: "inherit", shell: isWindows }
);

if (build.error) {
  fail(`Could not launch pyinstaller: ${build.error.message}`);
}
if (build.status !== 0) {
  fail("PyInstaller build failed.");
}

if (!fs.existsSync(path.join(sourceDir, childBinary))) {
  fail(`Missing python/dist/python-child/${childBinary}. Revisa el COLLECT de python/build.spec.`);
}
if (!fs.existsSync(path.join(sourceDir, "_internal"))) {
  fail("Missing python/dist/python-child/_internal/. Sin esa carpeta el binario no arranca.");
}

// Limpia la salida anterior (incluido el exe onefile de versiones viejas) antes
// de copiar, pero conserva los archivos versionados (.gitkeep).
fs.mkdirSync(outDir, { recursive: true });
for (const entry of fs.readdirSync(outDir)) {
  if (KEEP.has(entry)) {
    continue;
  }
  fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

console.log("[build-python] Copying python/dist/python-child/ to resources/python/...");
// verbatimSymlinks: en macOS los symlinks relativos de onedir (Python.framework,
// libs) deben quedar relativos; si se reescriben a rutas absolutas hacia python/dist/,
// quedan rotos dentro del .app.
fs.cpSync(sourceDir, outDir, { recursive: true, verbatimSymlinks: true });

const target = path.join(outDir, childBinary);
if (!fs.existsSync(target)) {
  fail(`Copy incompleto: falta ${path.relative(ROOT, target)}.`);
}
if (!isWindows) {
  fs.chmodSync(target, 0o755);
}

console.log(`[build-python] Done: ${path.relative(ROOT, target)} (+ _internal/).`);
