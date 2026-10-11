#!/usr/bin/env node
"use strict";

// Chequeo de sintaxis (node --check) de todos los archivos de electron/*.js y
// scripts/*.cjs. Reemplaza la lista escrita a mano en package.json: un archivo
// nuevo entra solo, sin tener que acordarse de agregarlo.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = [
  { dir: "electron", ext: ".js" },
  { dir: "scripts", ext: ".cjs" }
];

let checked = 0;
const failures = [];

for (const { dir, ext } of TARGETS) {
  const absDir = path.join(ROOT, dir);
  const files = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => entry.name)
    .sort();

  for (const name of files) {
    checked += 1;
    const result = spawnSync(process.execPath, ["--check", path.join(absDir, name)], {
      encoding: "utf8"
    });
    if (result.status !== 0) {
      failures.push(`${dir}/${name}\n${result.stderr || result.error?.message || ""}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-syntax] ${failures.length} archivo(s) con error de sintaxis:`);
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`[check-syntax] OK: ${checked} archivo(s) sin errores de sintaxis.`);
