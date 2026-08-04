#!/usr/bin/env node
"use strict";

// Cross-platform Python build:
// - Runs PyInstaller against python/build.spec.
// - Copies the resulting python-child binary into resources/python/.
// Windows produces python-child.exe; macOS/Linux produce python-child.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const childBinary = isWindows ? "python-child.exe" : "python-child";

function fail(message) {
  console.error(`[build-python] ${message}`);
  process.exit(1);
}

console.log("[build-python] Building Python executable with PyInstaller...");
const build = spawnSync(
  "pyinstaller",
  ["--clean", "--noconfirm", path.join("python", "build.spec")],
  { cwd: ROOT, stdio: "inherit", shell: isWindows }
);

if (build.error) {
  fail(`Could not launch pyinstaller: ${build.error.message}`);
}
if (build.status !== 0) {
  fail("PyInstaller build failed.");
}

const outDir = path.join(ROOT, "resources", "python");
fs.mkdirSync(outDir, { recursive: true });

const candidates = [
  path.join(ROOT, "dist", childBinary),
  path.join(ROOT, "dist", "python-child", childBinary)
];
const source = candidates.find((candidate) => fs.existsSync(candidate));
if (!source) {
  fail(`Could not find ${childBinary} in dist.`);
}

const target = path.join(outDir, childBinary);
console.log(`[build-python] Copying ${childBinary} to resources/python...`);
fs.copyFileSync(source, target);
if (!isWindows) {
  fs.chmodSync(target, 0o755);
}

console.log("[build-python] Done.");
