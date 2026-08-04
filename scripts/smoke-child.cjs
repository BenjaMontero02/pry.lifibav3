#!/usr/bin/env node
"use strict";

// Runtime smoke for the packaged Python backend.
//
// Launches the frozen python-child binary (resources/python/) and sends a
// single `ping` request. Because app/router.py imports the heavy native deps
// (insightface / onnxruntime / AdaFace) at module load, a successful `pong`
// proves the whole native stack loaded inside the bundle -- the exact failure
// mode (missing dylibs / hidden imports) that only shows up at runtime.
//
// Exits non-zero on any failure so CI catches broken bundles before shipping.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TIMEOUT_MS = 30000;
const isWindows = process.platform === "win32";
const childBinary = isWindows ? "python-child.exe" : "python-child";
const binaryPath = path.join(ROOT, "resources", "python", childBinary);

function fail(message) {
  console.error(`[smoke:child] FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`[smoke:child] OK: ${message}`);
  process.exit(0);
}

if (!fs.existsSync(binaryPath)) {
  fail(
    `${path.relative(ROOT, binaryPath)} not found. Run "pnpm run build:python" first.`
  );
}

console.log(`[smoke:child] Launching ${path.relative(ROOT, binaryPath)} ...`);

const child = spawn(binaryPath, [], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"]
});

let stdoutBuffer = "";
let stderrBuffer = "";
let settled = false;

const timer = setTimeout(() => {
  if (settled) {
    return;
  }
  settled = true;
  child.kill("SIGKILL");
  fail(
    `no valid response within ${TIMEOUT_MS}ms. ` +
      `stderr:\n${stderrBuffer.trim() || "(empty)"}`
  );
}, TIMEOUT_MS);

function finish(callback) {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  child.kill("SIGKILL");
  callback();
}

child.on("error", (error) => {
  finish(() => fail(`could not launch binary: ${error.message}`));
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString();
});

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();

  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    newlineIndex = stdoutBuffer.indexOf("\n");

    if (!line) {
      continue;
    }

    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      finish(() => fail(`non-JSON line from backend: ${line}`));
      return;
    }

    if (response.requestId !== "smoke-1") {
      continue;
    }

    if (response.ok && response.result && response.result.pong === true) {
      finish(() => pass("packaged python-child launched and responded to ping."));
    } else {
      finish(() =>
        fail(`unexpected ping response: ${JSON.stringify(response)}`)
      );
    }
    return;
  }
});

child.on("exit", (code, signal) => {
  finish(() =>
    fail(
      `backend exited before responding (code=${String(code)}, signal=${String(
        signal
      )}). stderr:\n${stderrBuffer.trim() || "(empty)"}`
    )
  );
});

child.stdin.write(
  JSON.stringify({ requestId: "smoke-1", action: "ping", data: {} }) + "\n"
);
