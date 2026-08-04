const EMPTY_INDEX_SUMMARY = Object.freeze({
  totalPhotos: 0,
  trackedPhotos: 0,
  indexedPhotos: 0,
  photosWithoutFaces: 0,
  unreadablePhotos: 0,
  errorPhotos: 0,
  pendingPhotos: 0,
  byStatus: {}
});

const EMPTY_THUMBNAIL_PREWARM = Object.freeze({
  sourcePath: null,
  reason: null,
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  queued: 0,
  active: 0,
  running: 0,
  inFlightCreations: 0,
  pending: 0,
  startedAt: null,
  finishedAt: null,
  updatedAt: null
});

function createEmptySourcepadWatchStatus() {
  return {
    sourcePath: null,
    watching: false,
    recursive: false,
    dirty: false,
    pendingRescan: false,
    debounceMs: 0,
    lastEvent: null,
    lastChangedAt: null,
    lastScannedAt: null,
    lastError: null,
    thumbnailPrewarm: EMPTY_THUMBNAIL_PREWARM
  };
}

const browserDesktopApi = {
  ping: async () => ({ pong: true, browserFallback: true }),
  sendToPython: async () => {
    throw new Error("Renderer is running outside Electron. Python actions are unavailable.");
  },
  invoke: async (channel, payload = {}) => {
    if (channel === "config:get-source-path") {
      return { key: "add source", value: "" };
    }
    if (channel === "config:pick-source-path") {
      return { canceled: true, value: null };
    }
    if (channel === "config:get-index-settings") {
      return { faceSizePx: 28, faceDetScore: 0.50 };
    }
    if (channel === "config:set-index-settings") {
      return { faceSizePx: payload?.faceSizePx ?? 28, faceDetScore: payload?.faceDetScore ?? 0.50 };
    }
    if (channel === "config:list-source-photos") {
      return {
        sourcePath: "",
        count: 0,
        total: 0,
        offset: Number(payload.offset || 0),
        limit: Number(payload.limit || 0),
        hasMore: false,
        query: String(payload.query || ""),
        statusFilter: String(payload.statusFilter || "all"),
        indexSummary: EMPTY_INDEX_SUMMARY,
        photos: []
      };
    }
    if (channel === "sourcepad:get-watch-status") {
      return createEmptySourcepadWatchStatus();
    }
    if (channel === "sourcepad:rescan") {
      const watchStatus = createEmptySourcepadWatchStatus();
      return {
        sourcePath: "",
        reason: String(payload.reason || "manual"),
        dirty: false,
        stale: false,
        changedAt: null,
        scannedAt: Date.now(),
        sourceTotal: 0,
        indexSummary: EMPTY_INDEX_SUMMARY,
        thumbnailPrewarm: EMPTY_THUMBNAIL_PREWARM,
        watchStatus
      };
    }
    if (channel === "index:get-status") {
      return { sourcePath: null, summary: EMPTY_INDEX_SUMMARY };
    }
    if (channel === "index:clear") {
      return { cleared: false, browserFallback: true };
    }
    if (channel === "photos:open-external") {
      return { opened: false, browserFallback: true };
    }
    if (channel === "player:get-preview-photos") {
      return { photos: [], updatedAt: null };
    }
    if (channel === "player:set-preview-photos") {
      return { sent: false, count: 0, updatedAt: Date.now(), browserFallback: true };
    }
    throw new Error(`Unsupported browser fallback IPC channel: ${String(channel)}`);
  },
  on: () => () => {}
};

export function getDesktopApi() {
  return window.desktopApi || browserDesktopApi;
}
