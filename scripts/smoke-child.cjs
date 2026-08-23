#!/usr/bin/env node
"use strict";

// Runtime smoke for the packaged Python backend.
//
// Launches the frozen python-child binary (resources/python/) and sends a
// `self_check` request, which builds the face analyzer inside the bundle and
// reports which models actually loaded.
//
// `ping` was not enough: it only proved the native imports resolved, so a
// bundle whose antelopev2 pack was empty (the CI failure that shipped .dmg and
// .exe installers without models) passed the smoke and failed in the
// operator's hands. This asserts the detector loaded AND that the intended
// embedding backend is active, so a silent fallback also fails the build.
//
// Exits non-zero on any failure so CI catches broken bundles before shipping.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
// Cargar antelopev2 + AdaFace dentro del bundle tarda decenas de segundos en
// un runner de CI; 30s quedaba al filo.
const TIMEOUT_MS = 120000;
const isWindows = process.platform === "win32";
const childBinary = isWindows ? "python-child.exe" : "python-child";
const binaryPath = path.join(ROOT, "resources", "python", childBinary);
// Debe coincidir con el backend previsto en face_index_service.py: si el
// AdaFace ONNX no quedo empaquetado, el backend cae a "insightface" en
// silencio, y eso tiene que romper el build.
const EXPECTED_EMBEDDING_BACKEND = "adaface";
// Debe coincidir con ALLOWED_MODULES de face_index_service.py. Cargar modulos
// de mas no es cosmetico: landmark_3d_68 reventaba en cada cara porque su
// meanshape_68.pkl no quedaba donde lo busca el binario congelado.
const EXPECTED_LOADED_MODULES = ["detection", "recognition"];

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

    if (!response.ok) {
      finish(() =>
        fail(
          `self_check failed: ${response.error || "(no message)"}
` +
            `stderr:
${stderrBuffer.trim() || "(empty)"}`
        )
      );
      return;
    }

    const result = response.result || {};
    const problems = [];
    if (result.detection !== true) {
      problems.push(
        `detector not loaded (loadedModels=${JSON.stringify(result.loadedModels)}, ` +
          `modelDir=${String(result.detectionModelDir)})`
      );
    }
    if (result.embeddingBackend !== EXPECTED_EMBEDDING_BACKEND) {
      problems.push(
        `embedding backend is "${String(result.embeddingBackend)}" instead of ` +
          `"${EXPECTED_EMBEDDING_BACKEND}" (adafaceModelPresent=` +
          `${String(result.adafaceModelPresent)}, adafaceSessionOk=` +
          `${String(result.adafaceSessionOk)}) -- the bundle is missing a model`
      );
    }

    const loadedModules = Array.isArray(result.loadedModels) ? [...result.loadedModels].sort() : [];
    if (loadedModules.join(",") !== [...EXPECTED_LOADED_MODULES].sort().join(",")) {
      problems.push(
        `loaded modules are ${JSON.stringify(loadedModules)} instead of ` +
          `${JSON.stringify([...EXPECTED_LOADED_MODULES].sort())} ` +
          `(unexpected=${JSON.stringify(result.unexpectedModules)})`
      );
    }
    // get_object() devuelve None en vez de fallar, asi que sin esta asercion un
    // bundle sin los data objects vuelve a pasar el smoke y romper en runtime.
    if (result.dataObjectsOk !== true) {
      problems.push(
        "insightface data objects missing from the bundle: get_object(\"meanshape_68.pkl\") " +
          "returned None (expected under <bundle>/objects/)"
      );
    }

    if (problems.length > 0) {
      finish(() =>
        fail(
          `${problems.join("; ")}
stderr:
${stderrBuffer.trim() || "(empty)"}`
        )
      );
      return;
    }

    finish(() =>
      pass(
        `packaged python-child loaded its models (models=${JSON.stringify(
          result.loadedModels
        )}, embeddingBackend=${result.embeddingBackend}).`
      )
    );
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
  JSON.stringify({ requestId: "smoke-1", action: "self_check", data: {} }) + "\n"
);
