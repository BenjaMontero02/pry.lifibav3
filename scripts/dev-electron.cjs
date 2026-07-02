const { spawn } = require("child_process");
const electronPath = require("electron");
const waitOn = require("wait-on");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function forwardSignal(child, signal) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

waitOn({ resources: ["tcp:127.0.0.1:5173"], timeout: 30000 })
  .then(() => {
    const child = spawn(electronPath, ["."], {
      env,
      stdio: "inherit",
      windowsHide: false
    });

    forwardSignal(child, "SIGINT");
    forwardSignal(child, "SIGTERM");

    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code || 0);
    });
  })
  .catch((error) => {
    console.error(`Electron dev startup failed: ${String(error.message || error)}`);
    process.exit(1);
  });
