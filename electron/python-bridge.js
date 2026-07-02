const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_STDERR_CHARS = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS_BY_ACTION = {
  ping: 30_000,
  find_player: 60_000,
  // Inactivity timeout: index_photos streams progress events over stdout and
  // every progress event for the request re-arms this timer, so it only fires
  // after the Python process stops reporting activity for this long.
  index_photos: 10 * 60_000
};

const resolveRequestTimeoutMs = (action) =>
  Object.prototype.hasOwnProperty.call(REQUEST_TIMEOUT_MS_BY_ACTION, action)
    ? REQUEST_TIMEOUT_MS_BY_ACTION[action]
    : DEFAULT_REQUEST_TIMEOUT_MS;

function createPythonBridge() {
  let pythonProcess = null;
  let nextRequestId = 1;
  const pending = new Map();
  const progressListeners = new Set();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let lastProcessError = null;
  let lastProcessExit = null;
  let lastResolvedCommand = null;

  const appendStderr = (chunk) => {
    const nextBuffer = `${stderrBuffer}${chunk}`;
    stderrBuffer = nextBuffer.length > MAX_STDERR_CHARS
      ? nextBuffer.slice(nextBuffer.length - MAX_STDERR_CHARS)
      : nextBuffer;
  };

  const resolvePythonCommand = () => {
    if (app.isPackaged) {
      return {
        command: path.join(process.resourcesPath, "python", "python-child.exe"),
        args: []
      };
    }

    const appPath = app.getAppPath();
    const venvWindowsPython = path.join(appPath, ".venv", "Scripts", "python.exe");
    const venvPosixPython = path.join(appPath, ".venv", "bin", "python");
    const command = fs.existsSync(venvWindowsPython)
      ? venvWindowsPython
      : fs.existsSync(venvPosixPython)
        ? venvPosixPython
        : "python";

    return {
      command,
      args: [path.join(appPath, "python", "main.py")]
    };
  };

  const buildNotRunningMessage = () => {
    const commandDescription = lastResolvedCommand
      ? `${lastResolvedCommand.command} ${lastResolvedCommand.args.join(" ")}`.trim()
      : "unresolved command";

    const details = [];
    if (lastProcessError) {
      details.push(`spawn error: ${lastProcessError}`);
    }
    if (lastProcessExit) {
      details.push(
        `exit code: ${String(lastProcessExit.code)}, signal: ${String(lastProcessExit.signal)}`
      );
    }
    if (stderrBuffer.trim()) {
      details.push(`stderr: ${stderrBuffer.trim()}`);
    }

    const detailsText = details.length > 0 ? ` Details: ${details.join(" | ")}` : "";
    return (
      `Python process is not running. Attempted executable: ${lastResolvedCommand ? lastResolvedCommand.command : "unresolved"}. Attempted command: ${commandDescription}.` +
      `${detailsText} ` +
      "Install Python 3.11+ and dependencies with `python -m pip install -r python/requirements.txt`, or build the packaged python-child executable."
    );
  };

  const clearPendingTimer = (pendingRequest) => {
    if (pendingRequest.timer) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.timer = null;
    }
  };

  const armPendingTimer = (requestId, pendingRequest) => {
    clearPendingTimer(pendingRequest);
    pendingRequest.timer = setTimeout(() => {
      pending.delete(requestId);
      pendingRequest.reject(
        new Error(
          `Python request timed out after ${pendingRequest.timeoutMs}ms without a response or progress ` +
          `(action: ${pendingRequest.action}, requestId: ${requestId}). ` +
          "The Python process may be hung or overloaded."
        )
      );
    }, pendingRequest.timeoutMs);
  };

  const flushLine = (line) => {
    if (!line.trim()) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return;
    }

    if (parsed.type === "progress") {
      if (parsed.requestId) {
        const activeRequest = pending.get(parsed.requestId);
        if (activeRequest) {
          armPendingTimer(parsed.requestId, activeRequest);
        }
      }
      progressListeners.forEach((listener) => {
        try {
          listener(parsed);
        } catch (_error) {
          // Ignore listener errors to avoid breaking bridge flow.
        }
      });
      return;
    }

    if (!parsed.requestId) {
      return;
    }

    const pendingRequest = pending.get(parsed.requestId);
    if (!pendingRequest) {
      return;
    }

    pending.delete(parsed.requestId);
    clearPendingTimer(pendingRequest);
    if (parsed.error) {
      pendingRequest.reject(new Error(parsed.error));
      return;
    }
    pendingRequest.resolve(parsed);
  };

  const start = () => {
    if (pythonProcess && !pythonProcess.killed) {
      return;
    }

    const python = resolvePythonCommand();
    lastResolvedCommand = python;
    stderrBuffer = "";
    lastProcessError = null;
    lastProcessExit = null;

    pythonProcess = spawn(python.command, python.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    pythonProcess.stdout.setEncoding("utf8");
    pythonProcess.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(flushLine);
    });

    pythonProcess.stderr.setEncoding("utf8");
    pythonProcess.stderr.on("data", (chunk) => {
      appendStderr(String(chunk || ""));
    });

    pythonProcess.on("error", (error) => {
      lastProcessError = String(error && error.message ? error.message : error);
    });

    pythonProcess.on("exit", (code, signal) => {
      lastProcessExit = { code, signal };
      pending.forEach((pendingRequest) => {
        clearPendingTimer(pendingRequest);
        pendingRequest.reject(new Error(buildNotRunningMessage()));
      });
      pending.clear();
      pythonProcess = null;
    });
  };

  const stop = () => {
    if (!pythonProcess || pythonProcess.killed) {
      return;
    }
    pythonProcess.kill();
  };

  const sendToPython = (action, data = {}) =>
    new Promise((resolve, reject) => {
      if (!pythonProcess || pythonProcess.killed) {
        start();
      }

      if (!pythonProcess || pythonProcess.killed) {
        reject(new Error(buildNotRunningMessage()));
        return;
      }

      const requestId = String(nextRequestId++);
      const pendingRequest = {
        resolve,
        reject,
        action,
        timeoutMs: resolveRequestTimeoutMs(action),
        timer: null
      };
      pending.set(requestId, pendingRequest);
      armPendingTimer(requestId, pendingRequest);

      const payload = { requestId, action, data };
      pythonProcess.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        if (!pending.has(requestId)) {
          return;
        }
        pending.delete(requestId);
        clearPendingTimer(pendingRequest);
        reject(
          new Error(
            `Failed to send payload to Python process: ${String(error.message || error)}. ${buildNotRunningMessage()}`
          )
        );
      });
    });

  const onProgress = (listener) => {
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  };

  return {
    start,
    stop,
    sendToPython,
    onProgress
  };
}

module.exports = {
  createPythonBridge
};
