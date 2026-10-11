const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_STDERR_CHARS = 4000;
const MAX_LOGGED_LINE_CHARS = 300;
// Tope de una linea de stdout (y del fragmento sin salto de linea acumulado).
// Una respuesta mas grande se descarta con warning en vez de crecer sin limite.
const MAX_STDOUT_LINE_CHARS = 8_000_000;
// Backoff ante crash en bucle: como mucho N arranques de Python dentro de la ventana.
const MAX_PYTHON_SPAWNS_PER_WINDOW = 5;
const PYTHON_SPAWN_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Python atiende los pedidos de a uno. Mientras un pedido espera en la cola
// (p. ej. un escaneo detras de un indexado) corre este timeout, mas largo; el
// propio del pedido arranca cuando Python avisa "started".
const QUEUED_REQUEST_TIMEOUT_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS_BY_ACTION = {
  ping: 30_000,
  // "started" llega antes de cargar los modelos faciales: la primera busqueda
  // puede tardar bastante mas que el resto. Si vence, el proceso se reinicia.
  find_player: 3 * 60_000,
  // Inactivity timeout: index_photos streams progress events over stdout and
  // every progress event for the request re-arms this timer, so it only fires
  // after the Python process stops reporting activity for this long.
  index_photos: 10 * 60_000
};

const resolveRequestTimeoutMs = (action) =>
  Object.prototype.hasOwnProperty.call(REQUEST_TIMEOUT_MS_BY_ACTION, action)
    ? REQUEST_TIMEOUT_MS_BY_ACTION[action]
    : DEFAULT_REQUEST_TIMEOUT_MS;

const killProcessTree = (child) => {
  if (!child || child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    // En desarrollo el python de .venv es un lanzador: matar solo el padre dejaria
    // huerfano al proceso real, que seguiria escribiendo el indice.
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      }).on("error", () => {});
    } catch {
      // Si taskkill no esta disponible, el child.kill() de abajo es el respaldo.
    }
  }
  try {
    child.kill();
  } catch {
    // El proceso ya termino.
  }
};

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
  // Marcas de arranque de los ultimos procesos, para el backoff ante crash en bucle.
  const spawnTimes = [];

  const appendStderr = (chunk) => {
    const nextBuffer = `${stderrBuffer}${chunk}`;
    stderrBuffer = nextBuffer.length > MAX_STDERR_CHARS
      ? nextBuffer.slice(nextBuffer.length - MAX_STDERR_CHARS)
      : nextBuffer;
  };

  const resolvePythonCommand = () => {
    if (app.isPackaged) {
      const childBinary =
        process.platform === "win32" ? "python-child.exe" : "python-child";
      return {
        command: path.join(process.resourcesPath, "python", childBinary),
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
      "Install Python 3.11+ and dependencies with `python -m pip install --require-hashes --no-deps -r python/requirements.lock`, or build the packaged python-child executable."
    );
  };

  const clearPendingTimer = (pendingRequest) => {
    if (pendingRequest.timer) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.timer = null;
    }
  };

  // Mata el proceso (y su arbol en Windows): un pedido ya iniciado que no responde
  // deja a Python ocupado, y los siguientes pedidos esperarian en cola sin fin.
  // El proximo sendToPython relanza el proceso.
  const abandonPythonProcess = (reason) => {
    const child = pythonProcess;
    pythonProcess = null;
    rejectAllPending(
      new Error(`Python se reinicio porque ${reason}. Los pedidos en cola se cancelaron; volve a intentarlo.`)
    );
    killProcessTree(child);
  };

  const armPendingTimer = (requestId, pendingRequest) => {
    clearPendingTimer(pendingRequest);
    const timeoutMs = pendingRequest.started ? pendingRequest.timeoutMs : QUEUED_REQUEST_TIMEOUT_MS;
    pendingRequest.timer = setTimeout(() => {
      pending.delete(requestId);
      pendingRequest.reject(
        new Error(
          pendingRequest.started
            ? `Python request timed out after ${timeoutMs}ms without a response or progress ` +
              `(action: ${pendingRequest.action}, requestId: ${requestId}). ` +
              "The Python process may be hung or overloaded."
            : `Python request waited ${timeoutMs}ms in queue without starting ` +
              `(action: ${pendingRequest.action}, requestId: ${requestId}). ` +
              "Another request is still running."
        )
      );
      if (pendingRequest.started) {
        abandonPythonProcess(
          `el pedido ${pendingRequest.action} (requestId ${requestId}) no respondio a tiempo`
        );
      }
    }, timeoutMs);
  };

  const rejectAllPending = (error) => {
    pending.forEach((pendingRequest) => {
      clearPendingTimer(pendingRequest);
      pendingRequest.reject(error);
    });
    pending.clear();
  };

  const flushLine = (line) => {
    if (!line.trim()) {
      return;
    }

    if (line.length > MAX_STDOUT_LINE_CHARS) {
      console.warn(`[python-bridge] Discarded oversized stdout line (${line.length} chars).`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // Una linea que no es JSON es salida de alguna libreria que se escapo del
      // redirect a stderr: no rompe el protocolo, pero hay que poder verla.
      console.warn(`[python-bridge] Discarded non-JSON stdout line: ${line.slice(0, MAX_LOGGED_LINE_CHARS)}`);
      return;
    }

    // JSON valido pero no objeto ("null", un numero, un string): no es un mensaje
    // del protocolo. Leer `.type` de null lanzaria dentro del handler de stdout.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[python-bridge] Ignored non-object stdout JSON: ${line.slice(0, MAX_LOGGED_LINE_CHARS)}`);
      return;
    }

    if (parsed.type === "started") {
      const startedRequest = parsed.requestId ? pending.get(parsed.requestId) : null;
      if (startedRequest) {
        startedRequest.started = true;
        armPendingTimer(parsed.requestId, startedRequest);
      }
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

    // Decidir por `ok`, no por si `error` es truthy: un error de mensaje vacio
    // ("" es falsy) se resolvia como exito y el fallo llegaba mudo a la UI.
    if (parsed.ok === false || parsed.error) {
      const detail =
        String(parsed.error || "").trim() ||
        `El backend reporto un fallo sin mensaje (action: ${pendingRequest.action}, ` +
          `requestId: ${parsed.requestId}).`;
      pendingRequest.reject(new Error(detail));
      return;
    }
    pendingRequest.resolve(parsed);
  };

  // Devuelve false si el relanzamiento quedo bloqueado por crash en bucle.
  const registerSpawnAttempt = () => {
    const now = Date.now();
    while (spawnTimes.length > 0 && now - spawnTimes[0] > PYTHON_SPAWN_WINDOW_MS) {
      spawnTimes.shift();
    }
    if (spawnTimes.length >= MAX_PYTHON_SPAWNS_PER_WINDOW) {
      return false;
    }
    spawnTimes.push(now);
    return true;
  };

  const start = () => {
    if (pythonProcess && !pythonProcess.killed) {
      return true;
    }

    if (!registerSpawnAttempt()) {
      return false;
    }

    const python = resolvePythonCommand();
    lastResolvedCommand = python;
    stderrBuffer = "";
    // Un fragmento de linea del proceso anterior se pegaria a la primera
    // respuesta del nuevo y la haria imposible de parsear.
    stdoutBuffer = "";
    lastProcessError = null;
    lastProcessExit = null;

    const child = spawn(python.command, python.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    pythonProcess = child;

    // Cada handler ignora eventos de un proceso que ya fue reemplazado: el
    // 'close' tardio del proceso viejo no puede rechazar pedidos del nuevo.
    const isCurrent = () => pythonProcess === child;
    // Tras descartar una linea demasiado grande, se tira el resto hasta el salto de linea.
    let skippingOversizedLine = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!isCurrent()) {
        return;
      }
      let text = String(chunk || "");
      if (skippingOversizedLine) {
        const newlineIndex = text.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        skippingOversizedLine = false;
        text = text.slice(newlineIndex + 1);
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
        console.warn(
          `[python-bridge] Discarded stdout fragment over ${MAX_STDOUT_LINE_CHARS} chars without a newline.`
        );
        stdoutBuffer = "";
        skippingOversizedLine = true;
      }
      lines.forEach(flushLine);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (!isCurrent()) {
        return;
      }
      const text = String(chunk || "");
      appendStderr(text);
      // Se loguea en vivo ademas de guardarlo: si Python se cae, el motivo queda en consola.
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) {
          return;
        }
        const truncated = line.length > MAX_LOGGED_LINE_CHARS ? "..." : "";
        console.log(`[python-bridge][stderr] ${line.slice(0, MAX_LOGGED_LINE_CHARS)}${truncated}`);
      });
    });

    const handleProcessGone = () => {
      if (!isCurrent()) {
        return;
      }
      pythonProcess = null;
      rejectAllPending(new Error(buildNotRunningMessage()));
    };

    // 'error' sin 'exit' (p. ej. el ejecutable no existe) dejaba pythonProcess
    // apuntando a un proceso muerto y nunca se reintentaba arrancarlo.
    child.on("error", (error) => {
      if (isCurrent()) {
        lastProcessError = String(error && error.message ? error.message : error);
      }
      handleProcessGone();
    });

    child.on("exit", (code, signal) => {
      if (isCurrent()) {
        lastProcessExit = { code, signal };
      }
    });

    // 'close' llega despues de que stdout se vacio: una respuesta escrita justo
    // antes de terminar ya fue procesada. En 'exit' todavia podia estar en el pipe.
    child.on("close", handleProcessGone);
    return true;
  };

  const stop = () => {
    if (!pythonProcess || pythonProcess.killed) {
      return;
    }
    pythonProcess.kill();
  };

  const sendToPython = (action, data = {}) =>
    new Promise((resolve, reject) => {
      let spawnBlocked = false;
      if (!pythonProcess || pythonProcess.killed) {
        spawnBlocked = !start();
      }

      if (!pythonProcess || pythonProcess.killed) {
        reject(
          new Error(
            spawnBlocked
              ? `Python se cayo o se reinicio ${MAX_PYTHON_SPAWNS_PER_WINDOW} veces en ` +
                `${PYTHON_SPAWN_WINDOW_MS / 1000} s; no se relanza hasta que pase esa ventana. ` +
                buildNotRunningMessage()
              : buildNotRunningMessage()
          )
        );
        return;
      }

      const requestId = String(nextRequestId++);
      const pendingRequest = {
        resolve,
        reject,
        action,
        timeoutMs: resolveRequestTimeoutMs(action),
        started: false,
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
