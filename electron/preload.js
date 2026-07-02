const { contextBridge, ipcRenderer } = require("electron");

const INVOKE_CHANNELS = new Set([
  "config:get-source-path",
  "config:set-source-path",
  "config:pick-source-path",
  "config:list-source-photos",
  "sourcepad:get-watch-status",
  "sourcepad:rescan",
  "index:get-status",
  "index:clear",
  "player:set-preview-photos",
  "player:get-preview-photos"
]);
const EVENT_CHANNELS = new Set([
  "python:progress",
  "player:preview-photos",
  "sourcepad:changed",
  "sourcepad:watch-error",
  "sourcepad:thumbnail-progress"
]);
const PYTHON_ACTIONS = new Set(["ping", "index_photos", "find_player"]);

function assertAllowed(value, allowed, type) {
  if (!allowed.has(value)) {
    throw new Error(`Unsupported ${type}: ${String(value)}`);
  }
}

contextBridge.exposeInMainWorld("desktopApi", {
  ping: () => ipcRenderer.invoke("python:request", { action: "ping", data: {} }),
  sendToPython: (action, data = {}) => {
    assertAllowed(action, PYTHON_ACTIONS, "Python action");
    return ipcRenderer.invoke("python:request", { action, data });
  },
  invoke: (channel, payload) => {
    assertAllowed(channel, INVOKE_CHANNELS, "IPC channel");
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, listener) => {
    assertAllowed(channel, EVENT_CHANNELS, "IPC event");
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
