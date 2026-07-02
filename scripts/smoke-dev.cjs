const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const viteHost = "127.0.0.1";
const vitePort = 5173;

const results = [];

function formatRelative(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/") || ".";
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_error) {
    return false;
  }
}

function add(status, label, detail, next) {
  results.push({ status, label, detail, next });
}

function printResults() {
  console.log("Dev smoke diagnostic");
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
  console.log("This diagnostic did not start Electron or Vite.");
}

function checkElectronRunAsNode() {
  const value = process.env.ELECTRON_RUN_AS_NODE;
  if (value) {
    add(
      "WARN",
      "ELECTRON_RUN_AS_NODE is set",
      `Current value: ${JSON.stringify(value)}. scripts/dev-electron.cjs clears it for Electron, but manual Electron launches can run as Node while this is set.`,
      "In this shell run: Remove-Item Env:ELECTRON_RUN_AS_NODE"
    );
    return;
  }

  add("OK", "ELECTRON_RUN_AS_NODE is not set", "Electron should not be forced into Node mode by this shell.");
}

function resolveElectronPackage() {
  const directDir = path.join(rootDir, "node_modules", "electron");
  const directPackageJson = path.join(directDir, "package.json");

  if (!exists(directDir)) {
    add(
      "FAIL",
      "node_modules/electron is missing",
      `${formatRelative(directDir)} was not found.`,
      "Install dependencies with: pnpm.cmd install"
    );
    return null;
  }

  if (exists(directPackageJson)) {
    add("OK", "node_modules/electron exists", `${formatRelative(directPackageJson)} is present.`);
    return directDir;
  }

  try {
    const resolvedPackageJson = require.resolve("electron/package.json", { paths: [rootDir] });
    add(
      "OK",
      "node_modules/electron resolves",
      `${formatRelative(directDir)} exists and resolves to ${formatRelative(resolvedPackageJson)}.`
    );
    return path.dirname(resolvedPackageJson);
  } catch (error) {
    add(
      "FAIL",
      "node_modules/electron is not usable",
      `${formatRelative(directDir)} exists, but electron/package.json could not be resolved: ${String(error.message || error)}`,
      "Repair dependencies with: pnpm.cmd install"
    );
    return null;
  }
}

function checkElectronBinary(electronDir) {
  if (!electronDir) {
    return;
  }

  const pathTxt = path.join(electronDir, "path.txt");
  if (!exists(pathTxt)) {
    add(
      "FAIL",
      "Electron path.txt is missing",
      `${formatRelative(pathTxt)} was not found. This usually means Electron postinstall did not finish.`,
      "Try: node node_modules/electron/install.js ; if that still fails, run: pnpm.cmd install --force"
    );
    return;
  }

  const executableName = fs.readFileSync(pathTxt, "utf8").trim();
  if (!executableName) {
    add(
      "FAIL",
      "Electron path.txt is empty",
      `${formatRelative(pathTxt)} exists but has no executable name.`,
      "Repair Electron with: node node_modules/electron/install.js"
    );
    return;
  }

  add("OK", "Electron path.txt exists", `${formatRelative(pathTxt)} -> ${executableName}`);

  const overrideDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  const electronBinary = overrideDistPath
    ? path.join(overrideDistPath, executableName)
    : path.join(electronDir, "dist", executableName);

  if (exists(electronBinary)) {
    add("OK", "Electron binary exists", formatRelative(electronBinary));
    return;
  }

  add(
    "FAIL",
    "Electron binary is missing",
    `${formatRelative(electronBinary)} was not found.`,
    "Repair Electron with: node node_modules/electron/install.js ; if needed, run: pnpm.cmd install --force"
  );
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (status, detail) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, detail });
    };

    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        finish("occupied", `${host}:${port} is already in use.`);
        return;
      }
      finish("error", `${host}:${port} could not be checked: ${String(error && error.message ? error.message : error)}`);
    });

    server.once("listening", () => {
      server.close(() => finish("free", `${host}:${port} is free.`));
    });

    server.listen({ host, port, exclusive: true });
  });
}

async function checkVitePort() {
  const port = await checkPort(viteHost, vitePort);
  if (port.status === "free") {
    add("OK", "Vite dev port is free", port.detail);
    return;
  }

  if (port.status === "occupied") {
    add(
      "WARN",
      "Vite dev port is occupied",
      port.detail,
      "If Vite is already running this is expected for pnpm.cmd run dev:electron. If not, stop the stale process before pnpm.cmd run dev."
    );
    return;
  }

  add("WARN", "Vite dev port check was inconclusive", port.detail, "Check manually with: netstat -ano | findstr :5173");
}

function runVersionCheck(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });

  if (result.error) {
    return { ok: false, output: String(result.error.message || result.error) };
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    ok: result.status === 0,
    output: output || `exit code ${String(result.status)}`
  };
}

function checkPythonEnvironment() {
  const pythonDir = path.join(rootDir, "python");
  const pythonMain = path.join(pythonDir, "main.py");
  const requirements = path.join(pythonDir, "requirements.txt");
  const pythonApplies = exists(pythonMain) || exists(requirements);

  if (!pythonApplies) {
    add("OK", "Python bridge is not configured", "No python/main.py or python/requirements.txt was found.");
    return;
  }

  const venvDir = path.join(rootDir, ".venv");
  const venvWindowsPython = path.join(venvDir, "Scripts", "python.exe");
  const venvPosixPython = path.join(venvDir, "bin", "python");

  if (exists(venvWindowsPython) || exists(venvPosixPython)) {
    const venvPython = exists(venvWindowsPython) ? venvWindowsPython : venvPosixPython;
    const version = runVersionCheck(venvPython, ["--version"]);
    if (version.ok) {
      add("OK", "Python .venv exists", `${formatRelative(venvPython)} -> ${version.output}`);
      return;
    }

    add(
      "WARN",
      "Python .venv exists but did not answer",
      `${formatRelative(venvPython)} -> ${version.output}`,
      "Recreate it with: python -m venv .venv ; .\\.venv\\Scripts\\python.exe -m pip install -r python\\requirements.txt"
    );
    return;
  }

  const fallback = runVersionCheck("python", ["--version"]);
  if (fallback.ok) {
    add(
      "WARN",
      "Python .venv is missing",
      `The bridge will fall back to PATH python: ${fallback.output}`,
      "For reproducible dev setup run: python -m venv .venv ; .\\.venv\\Scripts\\python.exe -m pip install -r python\\requirements.txt"
    );
    return;
  }

  add(
    "FAIL",
    "Python .venv is missing and PATH python is unavailable",
    fallback.output,
    "Install Python 3.11+ and run: python -m venv .venv ; .\\.venv\\Scripts\\python.exe -m pip install -r python\\requirements.txt"
  );
}

function checkPackageScripts() {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!exists(packageJsonPath)) {
    add("FAIL", "package.json is missing", `${formatRelative(packageJsonPath)} was not found.`);
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts || {};
  const available = ["dev", "dev:vite", "dev:electron", "check"].filter((script) => scripts[script]);

  add(
    "OK",
    "Lightweight npm scripts are available",
    available.length > 0 ? available.map((script) => `pnpm.cmd run ${script}`).join(", ") : "No expected dev scripts were found.",
    "After fixing FAIL items, run: pnpm.cmd run dev"
  );
}

async function main() {
  checkElectronRunAsNode();
  const electronDir = resolveElectronPackage();
  checkElectronBinary(electronDir);
  await checkVitePort();
  checkPythonEnvironment();
  checkPackageScripts();

  printResults();

  if (results.some((result) => result.status === "FAIL")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Smoke diagnostic failed unexpectedly: ${String(error && error.stack ? error.stack : error)}`);
  process.exitCode = 1;
});
