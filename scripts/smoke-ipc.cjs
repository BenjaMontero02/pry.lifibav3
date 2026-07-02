const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const requiredInvokeChannels = [
  "config:get-source-path",
  "sourcepad:get-watch-status",
  "sourcepad:rescan",
  "index:get-status",
  "player:get-preview-photos"
];
const requiredEventChannels = [
  "sourcepad:changed",
  "sourcepad:watch-error",
  "sourcepad:thumbnail-progress"
];
const optionalInvokeChannels = ["config:list-source-photos"];

const results = [];

function formatRelative(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/") || ".";
}

function add(status, label, detail, next) {
  results.push({ status, label, detail, next });
}

function readTextFile(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  try {
    return { ok: true, path: absolutePath, text: fs.readFileSync(absolutePath, "utf8") };
  } catch (error) {
    add(
      "FAIL",
      `${relativePath} is readable`,
      `${formatRelative(absolutePath)} could not be read: ${String(error.message || error)}`,
      "Restore the expected project file before running the IPC smoke."
    );
    return { ok: false, path: absolutePath, text: "" };
  }
}

function extractPreloadChannels(source, constantName) {
  const pattern = new RegExp(`const\\s+${constantName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = source.match(pattern);
  if (!match) {
    return null;
  }

  return new Set([...match[1].matchAll(/["']([^"']+)["']/g)].map((channel) => channel[1]));
}

function extractMainIpcHandlers(source) {
  return new Set([...source.matchAll(/ipcMain\.handle\s*\(\s*["']([^"']+)["']/g)].map((channel) => channel[1]));
}

function extractMainBroadcastChannels(source) {
  return new Set([...source.matchAll(/broadcastToAllWindows\s*\(\s*["']([^"']+)["']/g)].map((channel) => channel[1]));
}

function missingFrom(values, expected) {
  return expected.filter((value) => !values.has(value));
}

function hasAll(values, expected) {
  return Boolean(values) && missingFrom(values, expected).length === 0;
}

function runSmokeDevPrecheck() {
  const result = spawnSync(process.execPath, [path.join("scripts", "smoke-dev.cjs")], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });

  if (result.error) {
    add(
      "FAIL",
      "smoke:dev precheck ran",
      String(result.error.message || result.error),
      "Run pnpm.cmd run smoke:dev directly to inspect the environment."
    );
    return;
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status === 0) {
    add(
      "OK",
      "smoke:dev precheck passed",
      output ? "The existing dev diagnostic completed without FAIL items." : "pnpm smoke:dev exited 0."
    );
    return;
  }

  add(
    "FAIL",
    "smoke:dev precheck failed",
    output || `exit code ${String(result.status)}`,
    "Fix the dev smoke failures before trusting IPC availability."
  );
}

function checkPackageScript() {
  const packageFile = readTextFile("package.json");
  if (!packageFile.ok) {
    return;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageFile.text);
  } catch (error) {
    add(
      "FAIL",
      "package.json parses",
      String(error.message || error),
      "Fix package.json syntax."
    );
    return;
  }

  const smokeIpcScript = packageJson.scripts && packageJson.scripts["smoke:ipc"];
  if (smokeIpcScript === "node scripts/smoke-ipc.cjs") {
    add("OK", "smoke:ipc package script exists", "pnpm.cmd run smoke:ipc resolves to node scripts/smoke-ipc.cjs.");
    return;
  }

  add(
    "FAIL",
    "smoke:ipc package script exists",
    smokeIpcScript ? `Current value: ${JSON.stringify(smokeIpcScript)}` : "The script is missing.",
    "Set scripts.smoke:ipc to node scripts/smoke-ipc.cjs."
  );
}

function checkPreloadChannels() {
  const preloadFile = readTextFile(path.join("electron", "preload.js"));
  if (!preloadFile.ok) {
    return null;
  }

  const invokeChannels = extractPreloadChannels(preloadFile.text, "INVOKE_CHANNELS");
  if (!invokeChannels) {
    add(
      "FAIL",
      "preload invoke allowlist is parseable",
      "Could not find const INVOKE_CHANNELS = new Set([...]) in electron/preload.js.",
      "Keep the preload allowlist explicit or update scripts/smoke-ipc.cjs to match the new structure."
    );
  }

  const eventChannels = extractPreloadChannels(preloadFile.text, "EVENT_CHANNELS");
  if (!eventChannels) {
    add(
      "FAIL",
      "preload event allowlist is parseable",
      "Could not find const EVENT_CHANNELS = new Set([...]) in electron/preload.js.",
      "Keep the preload event allowlist explicit or update scripts/smoke-ipc.cjs to match the new structure."
    );
  }

  if (invokeChannels) {
    const missingRequired = missingFrom(invokeChannels, requiredInvokeChannels);
    if (missingRequired.length === 0) {
      add("OK", "preload exposes required IPC invoke channels", requiredInvokeChannels.join(", "));
    } else {
      add(
        "FAIL",
        "preload exposes required IPC invoke channels",
        `Missing: ${missingRequired.join(", ")}`,
        "Add the missing channels to INVOKE_CHANNELS before renderer code can invoke them."
      );
    }

    const missingOptional = missingFrom(invokeChannels, optionalInvokeChannels);
    if (missingOptional.length === 0) {
      add("OK", "preload exposes optional source-photo channel", optionalInvokeChannels.join(", "));
    } else {
      add(
        "WARN",
        "preload optional source-photo channel is unavailable",
        `Missing: ${missingOptional.join(", ")}`,
        "config:list-source-photos is optional for this smoke because it requires a valid sourcepad."
      );
    }
  }

  if (eventChannels) {
    const missingRequired = missingFrom(eventChannels, requiredEventChannels);
    if (missingRequired.length === 0) {
      add("OK", "preload exposes required IPC event channels", requiredEventChannels.join(", "));
    } else {
      add(
        "FAIL",
        "preload exposes required IPC event channels",
        `Missing: ${missingRequired.join(", ")}`,
        "Add the missing channels to EVENT_CHANNELS before renderer code can subscribe to them."
      );
    }
  }

  return { invokeChannels, eventChannels };
}

function checkMainChannels() {
  const mainFile = readTextFile(path.join("electron", "main.js"));
  if (!mainFile.ok) {
    return null;
  }

  const handlers = extractMainIpcHandlers(mainFile.text);
  const missingRequired = missingFrom(handlers, requiredInvokeChannels);
  if (missingRequired.length === 0) {
    add("OK", "main process registers required IPC handlers", requiredInvokeChannels.join(", "));
  } else {
    add(
      "FAIL",
      "main process registers required IPC handlers",
      `Missing: ${missingRequired.join(", ")}`,
      "Register the missing ipcMain.handle handlers before this smoke can pass."
    );
  }

  const missingOptional = missingFrom(handlers, optionalInvokeChannels);
  if (missingOptional.length === 0) {
    add("OK", "main process registers optional source-photo handler", optionalInvokeChannels.join(", "));
  } else {
    add(
      "WARN",
      "main process optional source-photo handler is unavailable",
      `Missing: ${missingOptional.join(", ")}`,
      "config:list-source-photos is optional for this smoke because it requires a valid sourcepad."
    );
  }

  const broadcasts = extractMainBroadcastChannels(mainFile.text);
  const missingBroadcasts = missingFrom(broadcasts, requiredEventChannels);
  if (missingBroadcasts.length === 0) {
    add("OK", "main process broadcasts required IPC events", requiredEventChannels.join(", "));
  } else {
    add(
      "FAIL",
      "main process broadcasts required IPC events",
      `Missing: ${missingBroadcasts.join(", ")}`,
      "Broadcast the missing sourcepad watcher events before renderer subscriptions can receive them."
    );
  }

  return { handlers, broadcasts };
}

function checkStaticSmokeBoundary(preloadChannels, mainChannels) {
  if (!preloadChannels || !mainChannels) {
    return;
  }

  const requiredAvailable = hasAll(preloadChannels.invokeChannels, requiredInvokeChannels) &&
    hasAll(mainChannels.handlers, requiredInvokeChannels) &&
    hasAll(preloadChannels.eventChannels, requiredEventChannels) &&
    hasAll(mainChannels.broadcasts, requiredEventChannels);
  if (!requiredAvailable) {
    return;
  }

  add(
    "OK",
    "required IPC surface is webcam-independent",
    "The smoke covers sourcepad watch status, sourcepad rescan, sourcepad watch events, config:get-source-path, index:get-status, and player:get-preview-photos; it does not call python:request, index_photos, find_player, or config:pick-source-path."
  );

  add(
    "SKIP",
    "live Electron IPC invocation",
    "Skipped by design: this checkout has no test-only automation hook, and reliable renderer-side IPC calls would require controlling Electron windows through DevTools or modifying Electron/preload.",
    "Use this static smoke as the safe automated check until a dedicated automation hook is added."
  );

  if (optionalInvokeChannels.every((channel) => preloadChannels.invokeChannels.has(channel) && mainChannels.handlers.has(channel))) {
    add(
      "SKIP",
      "config:list-source-photos runtime call",
      "The handler is present, but runtime invocation is skipped unless a valid sourcepad is guaranteed; calling it with a missing or stale source path is expected to throw."
    );
  }
}

function printResults() {
  console.log("IPC smoke diagnostic");
  console.log(`Workspace: ${rootDir}`);
  console.log("");

  for (const result of results) {
    console.log(`[${result.status}] ${result.label}`);
    if (result.detail) {
      console.log(`  ${result.detail}`);
    }
    if (result.next) {
      console.log(`  Next: ${result.next}`);
    }
  }

  console.log("");
  console.log("This smoke is static and starts with smoke:dev as its environment precheck.");
}

function main() {
  runSmokeDevPrecheck();
  checkPackageScript();
  const preloadChannels = checkPreloadChannels();
  const mainChannels = checkMainChannels();
  checkStaticSmokeBoundary(preloadChannels, mainChannels);

  printResults();

  if (results.some((result) => result.status === "FAIL")) {
    process.exitCode = 1;
  }
}

main();
