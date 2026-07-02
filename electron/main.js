const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const fs = require("fs");
const { createHash } = require("crypto");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, screen, shell } = require("electron");
const Database = require("better-sqlite3");
const { createPythonBridge } = require("./python-bridge");

let db = null;
let pythonBridge = null;
let operatorWindow = null;
let playerWindow = null;
let playerPreviewPayload = { photos: [], updatedAt: null };
let photoListCache = { sourcePath: null, loadedAt: 0, photos: [] };
let sourcepadWatcher = null;
let sourcepadRescanTimer = null;
let sourcepadRescanInFlight = null;
let sourcepadWatchToken = 0;
let sourcepadWatchState = {
  sourcePath: null,
  watching: false,
  recursive: false,
  dirty: false,
  lastEvent: null,
  lastChangedAt: null,
  lastScannedAt: null,
  lastError: null
};
let thumbnailPrewarmQueue = [];
let thumbnailPrewarmRunning = 0;
let thumbnailPrewarmLastProgressAt = 0;
let thumbnailPrewarmGeneration = 0;
const thumbnailPrewarmQueuedPaths = new Set();
const thumbnailPrewarmActivePaths = new Set();
const thumbnailCreationJobs = new Map();
let thumbnailPrewarmStats = {
  sourcePath: null,
  reason: null,
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  startedAt: null,
  finishedAt: null,
  updatedAt: null
};

const isDev = !app.isPackaged;
const SOURCE_PATH_CONFIG_KEY = "add source";
const PLAYER_PREVIEW_CONFIG_KEY = "player preview photos";
const SOURCE_PHOTO_SCHEME = "sourcephoto";
const SOURCE_THUMB_SCHEME = "sourcethumb";
const PHOTO_INDEX_STATUS_TABLE = "photo_index_status";
const PYTHON_ACTIONS = new Set(["ping", "index_photos", "find_player"]);
const DEFAULT_PHOTOS_PAGE_SIZE = 160;
const MAX_PHOTOS_PAGE_SIZE = 500;
const PHOTO_LIST_CACHE_MAX_AGE_MS = 30_000;
const SOURCEPAD_RESCAN_DEBOUNCE_MS = 900;
const THUMBNAIL_PREWARM_CONCURRENCY = 2;
const THUMBNAIL_PREWARM_RESCAN_LIMIT = 240;
const THUMBNAIL_PREWARM_PROGRESS_INTERVAL_MS = 600;
const SQLITE_BIND_CHUNK_SIZE = 900;
const PHOTO_STATUS_FILTERS = new Set(["all", "pending", "indexed", "no_faces", "faces_filtered", "error"]);
const SOURCE_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif"
]);

function normalizeComparablePath(value) {
  return path.resolve(value || "").toLowerCase();
}

function isPathInsideDirectory(filePath, directoryPath) {
  const file = path.resolve(filePath || "");
  const root = path.resolve(directoryPath || "");
  const relativePath = path.relative(root, file);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function realPathSync(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSearchQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhotoStatusFilter(value) {
  const statusFilter = String(value || "all").trim();
  return PHOTO_STATUS_FILTERS.has(statusFilter) ? statusFilter : "all";
}

function hasPhotoIndexError(statusRow) {
  return Boolean(String(statusRow?.last_error || "").trim());
}

function getPhotoFilterStatusFromIndexRow(statusRow) {
  if (!statusRow) {
    return "pending";
  }

  const indexedStatus = String(statusRow.indexed_status || "pending").trim();
  if (hasPhotoIndexError(statusRow) || indexedStatus === "error" || indexedStatus === "unreadable") {
    return "error";
  }
  if (
    indexedStatus === "indexed" ||
    indexedStatus === "no_faces" ||
    indexedStatus === "faces_filtered" ||
    indexedStatus === "pending"
  ) {
    return indexedStatus;
  }
  return "pending";
}

function getPublicIndexedStatusFromIndexRow(statusRow) {
  if (!statusRow) {
    return "pending";
  }

  const indexedStatus = String(statusRow.indexed_status || "pending").trim() || "pending";
  if (hasPhotoIndexError(statusRow) && indexedStatus !== "unreadable") {
    return "error";
  }
  return indexedStatus;
}

function clearPhotoListCache(sourcePath = null) {
  if (!sourcePath) {
    photoListCache = { sourcePath: null, loadedAt: 0, photos: [] };
    return;
  }

  const currentSourcePath = photoListCache.sourcePath || "";
  if (normalizeComparablePath(currentSourcePath) === normalizeComparablePath(sourcePath)) {
    photoListCache = { sourcePath: null, loadedAt: 0, photos: [] };
  }
}

function broadcastToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  });
}

function serializeError(error) {
  return {
    name: error?.name ? String(error.name) : "Error",
    message: String(error?.message || error)
  };
}

function getThumbnailPrewarmStatus() {
  return {
    ...thumbnailPrewarmStats,
    queued: thumbnailPrewarmQueue.length,
    active: thumbnailPrewarmActivePaths.size,
    running: thumbnailPrewarmRunning,
    inFlightCreations: thumbnailCreationJobs.size,
    pending: thumbnailPrewarmQueue.length + thumbnailPrewarmActivePaths.size
  };
}

function getSourcepadWatchStatus() {
  return {
    sourcePath: sourcepadWatchState.sourcePath,
    watching: Boolean(sourcepadWatcher) && sourcepadWatchState.watching,
    recursive: Boolean(sourcepadWatchState.recursive),
    dirty: Boolean(sourcepadWatchState.dirty),
    pendingRescan: Boolean(sourcepadRescanTimer || sourcepadRescanInFlight),
    debounceMs: SOURCEPAD_RESCAN_DEBOUNCE_MS,
    lastEvent: sourcepadWatchState.lastEvent,
    lastChangedAt: sourcepadWatchState.lastChangedAt,
    lastScannedAt: sourcepadWatchState.lastScannedAt,
    lastError: sourcepadWatchState.lastError,
    thumbnailPrewarm: getThumbnailPrewarmStatus()
  };
}

function clearSourcepadRescanTimer() {
  if (sourcepadRescanTimer) {
    clearTimeout(sourcepadRescanTimer);
    sourcepadRescanTimer = null;
  }
}

function handleSourcepadWatchError(sourcePath, error, context = {}) {
  const serialized = serializeError(error);
  const updatedAt = Date.now();
  sourcepadWatchState.lastError = serialized.message;
  if (context.dirty !== false) {
    sourcepadWatchState.dirty = true;
  }

  const payload = {
    sourcePath: sourcePath || sourcepadWatchState.sourcePath,
    reason: context.reason || "watch-error",
    eventType: context.eventType || null,
    filename: context.filename || null,
    error: serialized,
    message: serialized.message,
    updatedAt,
    watchStatus: getSourcepadWatchStatus()
  };
  broadcastToAllWindows("sourcepad:watch-error", payload);
  return payload;
}

function resetThumbnailPrewarmQueue() {
  thumbnailPrewarmGeneration += 1;
  thumbnailPrewarmQueue = [];
  thumbnailPrewarmQueuedPaths.clear();
  thumbnailPrewarmStats = {
    sourcePath: null,
    reason: null,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: Date.now()
  };
}

function emitThumbnailPrewarmProgress({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - thumbnailPrewarmLastProgressAt < THUMBNAIL_PREWARM_PROGRESS_INTERVAL_MS) {
    return;
  }

  thumbnailPrewarmLastProgressAt = now;
  broadcastToAllWindows("sourcepad:thumbnail-progress", {
    ...getThumbnailPrewarmStatus(),
    updatedAt: now
  });
}

function startThumbnailPrewarmWorkers() {
  while (
    thumbnailPrewarmRunning < THUMBNAIL_PREWARM_CONCURRENCY &&
    thumbnailPrewarmQueue.length > 0
  ) {
    const job = thumbnailPrewarmQueue.shift();
    const generation = thumbnailPrewarmGeneration;
    thumbnailPrewarmQueuedPaths.delete(job.photoPath);
    thumbnailPrewarmActivePaths.add(job.photoPath);
    thumbnailPrewarmRunning += 1;

    runThumbnailPrewarmJob(job, generation)
      .catch((error) => {
        if (generation === thumbnailPrewarmGeneration) {
          thumbnailPrewarmStats.failed += 1;
          handleSourcepadWatchError(job.sourcePath, error, {
            reason: "thumbnail-prewarm",
            filename: job.photoPath,
            dirty: false
          });
        }
      })
      .finally(() => {
        thumbnailPrewarmActivePaths.delete(job.photoPath);
        thumbnailPrewarmRunning = Math.max(0, thumbnailPrewarmRunning - 1);
        if (generation !== thumbnailPrewarmGeneration) {
          startThumbnailPrewarmWorkers();
          return;
        }
        thumbnailPrewarmStats.updatedAt = Date.now();
        if (thumbnailPrewarmQueue.length === 0 && thumbnailPrewarmRunning === 0) {
          thumbnailPrewarmStats.finishedAt = thumbnailPrewarmStats.updatedAt;
          emitThumbnailPrewarmProgress({ force: true });
        } else {
          emitThumbnailPrewarmProgress();
        }
        startThumbnailPrewarmWorkers();
      });
  }
}

async function runThumbnailPrewarmJob(job, generation) {
  if (generation !== thumbnailPrewarmGeneration) {
    return;
  }

  const result = validateSourceImagePath(job.photoPath);
  if (generation !== thumbnailPrewarmGeneration) {
    return;
  }
  if (!result.ok) {
    thumbnailPrewarmStats.skipped += 1;
    return;
  }

  const thumbnailPath = await getOrCreateThumbnail(result.realPhotoPath, result.stats);
  if (generation !== thumbnailPrewarmGeneration) {
    return;
  }
  if (thumbnailPath) {
    thumbnailPrewarmStats.completed += 1;
  } else {
    thumbnailPrewarmStats.skipped += 1;
  }
}

function queueThumbnailPrewarm(photos, sourcePath, options = {}) {
  const candidates = (Array.isArray(photos) ? photos : [])
    .map((photo) => String(photo?.path || ""))
    .filter(Boolean)
    .slice(0, clampInteger(options.limit, THUMBNAIL_PREWARM_RESCAN_LIMIT, { min: 0 }));

  if (candidates.length === 0) {
    return getThumbnailPrewarmStatus();
  }

  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const now = Date.now();
  if (
    options.reset ||
    normalizeComparablePath(thumbnailPrewarmStats.sourcePath || "") !==
    normalizeComparablePath(normalizedSourcePath)
  ) {
    resetThumbnailPrewarmQueue();
  }

  thumbnailPrewarmStats.sourcePath = normalizedSourcePath;
  thumbnailPrewarmStats.reason = options.reason || "sourcepad";
  thumbnailPrewarmStats.startedAt = thumbnailPrewarmStats.startedAt || now;
  thumbnailPrewarmStats.finishedAt = null;

  let queued = 0;
  for (const photoPath of candidates) {
    if (thumbnailPrewarmQueuedPaths.has(photoPath) || thumbnailPrewarmActivePaths.has(photoPath)) {
      continue;
    }
    thumbnailPrewarmQueuedPaths.add(photoPath);
    thumbnailPrewarmQueue.push({ sourcePath: normalizedSourcePath, photoPath });
    queued += 1;
  }

  if (queued > 0) {
    thumbnailPrewarmStats.total += queued;
    thumbnailPrewarmStats.updatedAt = now;
    emitThumbnailPrewarmProgress({ force: true });
    startThumbnailPrewarmWorkers();
  }

  return getThumbnailPrewarmStatus();
}

function handleSourcepadDirty(sourcePath, eventType, filename) {
  if (
    sourcepadWatchState.sourcePath &&
    normalizeComparablePath(sourcepadWatchState.sourcePath) !== normalizeComparablePath(sourcePath)
  ) {
    return;
  }

  const now = Date.now();
  const event = {
    eventType: eventType ? String(eventType) : null,
    filename: filename ? String(filename) : null,
    noticedAt: now
  };

  clearPhotoListCache(sourcePath);
  sourcepadWatchState.dirty = true;
  sourcepadWatchState.lastEvent = event;
  sourcepadWatchState.lastChangedAt = now;
  sourcepadWatchState.lastError = null;
  scheduleSourcepadRescan("watch");
}

function scheduleSourcepadRescan(reason, delayMs = SOURCEPAD_RESCAN_DEBOUNCE_MS) {
  if (!sourcepadWatchState.sourcePath) {
    return;
  }

  clearSourcepadRescanTimer();
  sourcepadRescanTimer = setTimeout(() => {
    sourcepadRescanTimer = null;
    rescanSourcepad({ reason, sourcePath: sourcepadWatchState.sourcePath }).catch(() => {});
  }, delayMs);
}

async function rescanSourcepad(options = {}) {
  const sourcePath = options.sourcePath
    ? normalizeSourcePath(options.sourcePath)
    : getSourcePathFromConfiguration({ required: true });
  const sourceKey = normalizeComparablePath(sourcePath);

  if (
    sourcepadRescanInFlight &&
    normalizeComparablePath(sourcepadRescanInFlight.sourcePath) === sourceKey
  ) {
    return sourcepadRescanInFlight.promise;
  }

  const promise = (async () => {
    clearPhotoListCache(sourcePath);
    const photos = await getCachedSourcePhotos(sourcePath, { refresh: true });
    const currentSourcePath = getSourcePathFromConfiguration({ required: false });
    const stillCurrent =
      currentSourcePath &&
      normalizeComparablePath(currentSourcePath) === normalizeComparablePath(sourcePath);
    const scannedAt = Date.now();
    const summary = getPhotoIndexSummary(sourcePath, photos.length);
    const prewarm = stillCurrent
      ? queueThumbnailPrewarm(photos, sourcePath, {
          reason: options.reason || "sourcepad:rescan",
          limit: THUMBNAIL_PREWARM_RESCAN_LIMIT,
          reset: true
        })
      : getThumbnailPrewarmStatus();

    const payload = {
      sourcePath,
      reason: options.reason || "manual",
      dirty: false,
      stale: !stillCurrent,
      changedAt: sourcepadWatchState.lastChangedAt,
      scannedAt,
      sourceTotal: photos.length,
      indexSummary: summary,
      thumbnailPrewarm: prewarm
    };

    if (stillCurrent) {
      sourcepadWatchState.dirty = false;
      sourcepadWatchState.lastScannedAt = scannedAt;
      sourcepadWatchState.lastError = null;
      payload.watchStatus = getSourcepadWatchStatus();
      broadcastToAllWindows("sourcepad:changed", payload);
    }

    return payload;
  })();

  sourcepadRescanInFlight = { sourcePath, promise };
  try {
    return await promise;
  } catch (error) {
    handleSourcepadWatchError(sourcePath, error, { reason: options.reason || "manual" });
    throw error;
  } finally {
    if (sourcepadRescanInFlight?.promise === promise) {
      sourcepadRescanInFlight = null;
    }
  }
}

function stopSourcepadWatcher() {
  sourcepadWatchToken += 1;
  clearSourcepadRescanTimer();
  if (sourcepadWatcher) {
    sourcepadWatcher.close();
    sourcepadWatcher = null;
  }
  sourcepadWatchState.watching = false;
  sourcepadWatchState.recursive = false;
}

function startSourcepadWatcher(sourcePath) {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  if (
    sourcepadWatcher &&
    sourcepadWatchState.sourcePath &&
    normalizeComparablePath(sourcepadWatchState.sourcePath) === normalizeComparablePath(normalizedSourcePath)
  ) {
    return getSourcepadWatchStatus();
  }

  stopSourcepadWatcher();
  resetThumbnailPrewarmQueue();

  const token = sourcepadWatchToken;
  const onDirty = (eventType, filename) => {
    if (token !== sourcepadWatchToken) {
      return;
    }
    handleSourcepadDirty(normalizedSourcePath, eventType, filename);
  };

  sourcepadWatchState = {
    sourcePath: normalizedSourcePath,
    watching: false,
    recursive: false,
    dirty: false,
    lastEvent: null,
    lastChangedAt: null,
    lastScannedAt: null,
    lastError: null
  };

  try {
    try {
      sourcepadWatcher = fs.watch(normalizedSourcePath, { persistent: false, recursive: true }, onDirty);
      sourcepadWatchState.recursive = true;
    } catch {
      sourcepadWatcher = fs.watch(normalizedSourcePath, { persistent: false }, onDirty);
      sourcepadWatchState.recursive = false;
    }

    sourcepadWatcher.on("error", (error) => {
      if (token === sourcepadWatchToken) {
        handleSourcepadWatchError(normalizedSourcePath, error, { reason: "watcher" });
      }
    });
    sourcepadWatchState.watching = true;
    sourcepadWatchState.lastError = null;
    scheduleSourcepadRescan("watch-start", 0);
  } catch (error) {
    sourcepadWatcher = null;
    sourcepadWatchState.watching = false;
    handleSourcepadWatchError(normalizedSourcePath, error, { reason: "watch-start" });
  }

  return getSourcepadWatchStatus();
}

function startSourcepadWatcherFromConfiguration() {
  const sourcePath = getSourcePathFromConfiguration({ required: false });
  if (!sourcePath) {
    stopSourcepadWatcher();
    sourcepadWatchState = {
      sourcePath: null,
      watching: false,
      recursive: false,
      dirty: false,
      lastEvent: null,
      lastChangedAt: null,
      lastScannedAt: null,
      lastError: null
    };
    return getSourcepadWatchStatus();
  }

  return startSourcepadWatcher(sourcePath);
}

function createPhotoIndexStatusTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PHOTO_INDEX_STATUS_TABLE} (
      absolute_path TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      mtime_ns INTEGER,
      file_size INTEGER,
      indexed_status TEXT NOT NULL,
      last_indexed_at INTEGER,
      last_error TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_photo_index_status_source_path
    ON ${PHOTO_INDEX_STATUS_TABLE} (source_path)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_photo_index_status_source_status
    ON ${PHOTO_INDEX_STATUS_TABLE} (source_path, indexed_status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_photo_index_status_source_last_error
    ON ${PHOTO_INDEX_STATUS_TABLE} (source_path, last_error)
  `);
}

function loadManifestState(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid manifest JSON at ${manifestPath}: ${String(error.message || error)}`);
  }

  const photosState = manifest?.photos;
  if (!photosState || typeof photosState !== "object" || Array.isArray(photosState)) {
    throw new Error(`Manifest has invalid "photos" payload at ${manifestPath}.`);
  }

  return photosState;
}

function syncPhotoIndexStatusFromManifest(sourcePath, manifestPath) {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const photosState = loadManifestState(manifestPath);
  const expectedSource = normalizeComparablePath(normalizedSourcePath);
  const rows = [];

  for (const [absolutePath, state] of Object.entries(photosState)) {
    if (!isPathInsideDirectory(absolutePath, normalizedSourcePath)) {
      continue;
    }

    const normalizedPhotoPath = normalizeComparablePath(absolutePath);
    if (!normalizedPhotoPath.startsWith(expectedSource)) {
      continue;
    }

    rows.push({
      absolute_path: path.resolve(absolutePath),
      source_path: normalizedSourcePath,
      mtime_ns: Number.isFinite(Number(state?.mtime_ns)) ? Number(state.mtime_ns) : null,
      file_size: Number.isFinite(Number(state?.size)) ? Number(state.size) : null,
      indexed_status: String(state?.status || "unknown"),
      last_indexed_at: Number.isFinite(Number(state?.indexed_at)) ? Number(state.indexed_at) : null,
      last_error: state?.error ? String(state.error) : null
    });
  }

  const upsertRow = db.prepare(`
    INSERT INTO ${PHOTO_INDEX_STATUS_TABLE} (
      absolute_path,
      source_path,
      mtime_ns,
      file_size,
      indexed_status,
      last_indexed_at,
      last_error
    )
    VALUES (
      @absolute_path,
      @source_path,
      @mtime_ns,
      @file_size,
      @indexed_status,
      @last_indexed_at,
      @last_error
    )
    ON CONFLICT(absolute_path) DO UPDATE SET
      source_path = excluded.source_path,
      mtime_ns = excluded.mtime_ns,
      file_size = excluded.file_size,
      indexed_status = excluded.indexed_status,
      last_indexed_at = excluded.last_indexed_at,
      last_error = excluded.last_error
  `);
  const loadExistingBySource = db.prepare(`
    SELECT absolute_path
    FROM ${PHOTO_INDEX_STATUS_TABLE}
    WHERE source_path = ?
  `);
  const deleteByAbsolutePath = db.prepare(`
    DELETE FROM ${PHOTO_INDEX_STATUS_TABLE}
    WHERE absolute_path = ?
  `);

  const transaction = db.transaction(() => {
    const currentPaths = new Set();
    for (const row of rows) {
      upsertRow.run(row);
      currentPaths.add(row.absolute_path);
    }

    const existingRows = loadExistingBySource.all(normalizedSourcePath);
    for (const existingRow of existingRows) {
      if (!currentPaths.has(existingRow.absolute_path)) {
        deleteByAbsolutePath.run(existingRow.absolute_path);
      }
    }
  });

  transaction();
}

function createDatabase() {
  const dbPath = path.join(app.getPath("userData"), "app.sqlite");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "key" TEXT NOT NULL UNIQUE,
      "value" TEXT
    )
  `);
  createPhotoIndexStatusTable();
}

function getWindowUrl(windowName) {
  if (isDev) {
    return `http://127.0.0.1:5173/${windowName}.html`;
  }
  return path.join(app.getAppPath(), "dist", `${windowName}.html`);
}

function isAllowedNavigationUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  if (isDev && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === "5173") {
    return true;
  }

  if (parsed.protocol === "file:") {
    try {
      return isPathInsideDirectory(fileURLToPath(parsed), app.getAppPath());
    } catch {
      return false;
    }
  }

  return false;
}

function hardenWindowWebContents(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigationUrl(targetUrl)) {
      event.preventDefault();
    }
  });
}

function createWindow(windowName, displayBounds) {
  const window = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  hardenWindowWebContents(window);

  if (isDev) {
    window.loadURL(getWindowUrl(windowName));
  } else {
    window.loadFile(getWindowUrl(windowName));
  }

  return window;
}

function createAppWindows() {
  const displays = screen.getAllDisplays();
  const primary = displays[0].bounds;
  const secondary = (displays[1] || displays[0]).bounds;

  operatorWindow = createWindow("operator", primary);
  playerWindow = createWindow("player", secondary);
}

function normalizeSourcePath(value) {
  if (typeof value !== "string") {
    throw new Error("Source path must be a string.");
  }

  const normalized = path.resolve(value.trim());
  if (!normalized) {
    throw new Error("Source path cannot be empty.");
  }

  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`Configured source folder does not exist: ${normalized}`);
  }

  return normalized;
}

function getConfigurationValue(configKey) {
  const row = db
    .prepare('SELECT "value" FROM configuration WHERE "key" = ? LIMIT 1')
    .get(configKey);
  return row ? row.value : null;
}

function setConfigurationValue(configKey, configValue) {
  db.prepare(
    `
      INSERT INTO configuration ("key", "value")
      VALUES (?, ?)
      ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"
    `
  ).run(configKey, configValue);
}

function sanitizePlayerPreviewPhotos(inputPhotos) {
  return (Array.isArray(inputPhotos) ? inputPhotos : [])
    .filter((photo) => photo && typeof photo === "object")
    .map((photo) => ({
      photoPath: String(photo.photoPath || ""),
      url: String(photo.url || ""),
      similarity: Number.isFinite(Number(photo.similarity)) ? Number(photo.similarity) : null,
      displayNumber: Number.isFinite(Number(photo.displayNumber)) ? Number(photo.displayNumber) : null
    }))
    .filter((photo) => photo.photoPath && photo.url);
}

function sanitizePlayerPreviewPayload(payload, fallbackUpdatedAt = null) {
  const rawUpdatedAt = payload?.updatedAt;
  const updatedAt = rawUpdatedAt === null || rawUpdatedAt === undefined ? NaN : Number(rawUpdatedAt);
  return {
    photos: sanitizePlayerPreviewPhotos(payload?.photos),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : fallbackUpdatedAt
  };
}

function loadPlayerPreviewPayloadFromConfiguration() {
  const value = getConfigurationValue(PLAYER_PREVIEW_CONFIG_KEY);
  if (!value) {
    playerPreviewPayload = { photos: [], updatedAt: null };
    return;
  }

  try {
    playerPreviewPayload = sanitizePlayerPreviewPayload(JSON.parse(value));
  } catch {
    playerPreviewPayload = { photos: [], updatedAt: null };
  }
}

function persistPlayerPreviewPayload(payload) {
  setConfigurationValue(
    PLAYER_PREVIEW_CONFIG_KEY,
    JSON.stringify(sanitizePlayerPreviewPayload(payload))
  );
}

function getSourcePathFromConfiguration({ required = true } = {}) {
  const value = getConfigurationValue(SOURCE_PATH_CONFIG_KEY);
  if (!value) {
    if (required) {
      throw new Error(
        `Missing source path configuration. Set configuration key "${SOURCE_PATH_CONFIG_KEY}" first.`
      );
    }
    return null;
  }

  try {
    return normalizeSourcePath(value);
  } catch (error) {
    if (required) {
      throw error;
    }
    return null;
  }
}

function getSourcePhotoUrl(filePath) {
  return `${SOURCE_PHOTO_SCHEME}://${encodeURIComponent(filePath)}`;
}

function getSourceThumbnailUrl(filePath) {
  return `${SOURCE_THUMB_SCHEME}://${encodeURIComponent(filePath)}`;
}

function getFaceIndexDir() {
  return path.join(app.getPath("userData"), "face-index");
}

function getThumbnailCacheDir() {
  return path.join(app.getPath("userData"), "thumb-cache");
}

function getThumbnailCachePath(photoPath, stats) {
  const hash = createHash("sha1")
    .update(`${photoPath}|${String(stats.mtimeNs || stats.mtimeMs)}|${String(stats.size)}`)
    .digest("hex");
  return path.join(getThumbnailCacheDir(), hash.slice(0, 2), `${hash}.jpg`);
}

function validateSourceImagePath(inputPath) {
  const normalizedPath = path.resolve(inputPath);
  const sourceRoot = getSourcePathFromConfiguration({ required: false });
  const extension = path.extname(normalizedPath).toLowerCase();

  if (!sourceRoot || !SOURCE_IMAGE_EXTENSIONS.has(extension)) {
    return { ok: false, status: 403 };
  }

  if (!fs.existsSync(normalizedPath)) {
    return { ok: false, status: 404 };
  }

  const stats = fs.statSync(normalizedPath);
  if (!stats.isFile()) {
    return { ok: false, status: 404 };
  }

  const realPhotoPath = realPathSync(normalizedPath);
  const realSourceRoot = realPathSync(sourceRoot);
  if (!isPathInsideDirectory(realPhotoPath, realSourceRoot)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, realPhotoPath, stats };
}

function decodeProtocolPath(request, scheme) {
  const encodedPath = request.url.slice(`${scheme}://`.length);
  return decodeURIComponent(encodedPath || "");
}

function registerSourcePhotoProtocol() {
  protocol.handle(SOURCE_PHOTO_SCHEME, (request) => {
    try {
      const decodedPath = decodeProtocolPath(request, SOURCE_PHOTO_SCHEME);
      const result = validateSourceImagePath(decodedPath);
      if (!result.ok) {
        return new Response(result.status === 403 ? "Forbidden" : "Not found", { status: result.status });
      }

      return net.fetch(pathToFileURL(result.realPhotoPath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

async function getOrCreateThumbnail(realPhotoPath, stats) {
  const thumbnailStats = {
    mtimeNs: Number.isFinite(Number(stats.mtimeNs)) ? Number(stats.mtimeNs) : null,
    mtimeMs: stats.mtimeMs,
    size: stats.size
  };
  const cachePath = getThumbnailCachePath(realPhotoPath, thumbnailStats);

  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  const inFlight = thumbnailCreationJobs.get(cachePath);
  if (inFlight) {
    return inFlight;
  }

  const job = (async () => {
    if (fs.existsSync(cachePath)) {
      return cachePath;
    }

    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const thumbnail = await nativeImage.createThumbnailFromPath(realPhotoPath, { width: 256, height: 256 });
    if (!thumbnail || thumbnail.isEmpty()) {
      return null;
    }

    const jpeg = thumbnail.toJPEG(78);
    await fs.promises.writeFile(cachePath, jpeg);
    return cachePath;
  })();

  thumbnailCreationJobs.set(cachePath, job);
  try {
    return await job;
  } finally {
    thumbnailCreationJobs.delete(cachePath);
  }
}

function registerSourceThumbnailProtocol() {
  protocol.handle(SOURCE_THUMB_SCHEME, async (request) => {
    try {
      const decodedPath = decodeProtocolPath(request, SOURCE_THUMB_SCHEME);
      const result = validateSourceImagePath(decodedPath);
      if (!result.ok) {
        return new Response(result.status === 403 ? "Forbidden" : "Not found", { status: result.status });
      }

      const thumbnailPath = await getOrCreateThumbnail(result.realPhotoPath, result.stats);
      if (!thumbnailPath) {
        return new Response("Not found", { status: 404 });
      }

      return net.fetch(pathToFileURL(thumbnailPath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function createPhotoIndexSummaryFromGroupedRows(rows, totalPhotos = 0) {
  const byStatus = {};
  let tracked = 0;
  let lastErrorPhotos = 0;
  for (const row of rows) {
    const status = String(row.status || "unknown");
    const count = Number(row.count || 0);
    const lastErrorCount = Number(row.last_error_count || 0);
    byStatus[status] = count;
    tracked += count;
    if (status !== "error" && status !== "unreadable") {
      lastErrorPhotos += lastErrorCount;
    }
  }

  const unreadablePhotos = byStatus.unreadable || 0;
  const errorPhotos = (byStatus.error || 0) + lastErrorPhotos;
  const pendingPhotos = Math.max(0, totalPhotos - tracked);

  return {
    totalPhotos,
    trackedPhotos: tracked,
    indexedPhotos: byStatus.indexed || 0,
    photosWithoutFaces: byStatus.no_faces || 0,
    unreadablePhotos,
    errorPhotos,
    pendingPhotos,
    byStatus,
    statusCounts: {
      all: totalPhotos,
      pending: pendingPhotos,
      indexed: byStatus.indexed || 0,
      no_faces: byStatus.no_faces || 0,
      faces_filtered: byStatus.faces_filtered || 0,
      error: errorPhotos + unreadablePhotos
    }
  };
}

function createPhotoIndexSummaryFromStatusRows(rows, totalPhotos = 0) {
  const groupedRowsByStatus = new Map();

  for (const row of rows) {
    const status = String(row.indexed_status || "unknown");
    const groupedRow = groupedRowsByStatus.get(status) || {
      status,
      count: 0,
      last_error_count: 0
    };
    groupedRow.count += 1;
    if (hasPhotoIndexError(row)) {
      groupedRow.last_error_count += 1;
    }
    groupedRowsByStatus.set(status, groupedRow);
  }

  return createPhotoIndexSummaryFromGroupedRows([...groupedRowsByStatus.values()], totalPhotos);
}

function getPhotoIndexSummary(sourcePath, totalPhotos = 0) {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const rows = db
    .prepare(
      `
        SELECT indexed_status AS status, COUNT(*) AS count
        , SUM(CASE WHEN last_error IS NOT NULL AND TRIM(last_error) <> '' THEN 1 ELSE 0 END) AS last_error_count
        FROM ${PHOTO_INDEX_STATUS_TABLE}
        WHERE source_path = ?
        GROUP BY indexed_status
      `
    )
    .all(normalizedSourcePath);

  return createPhotoIndexSummaryFromGroupedRows(rows, totalPhotos);
}

function createEmptyPhotoIndexSummary() {
  return {
    totalPhotos: 0,
    trackedPhotos: 0,
    indexedPhotos: 0,
    photosWithoutFaces: 0,
    unreadablePhotos: 0,
    errorPhotos: 0,
    pendingPhotos: 0,
    byStatus: {},
    statusCounts: {
      all: 0,
      pending: 0,
      indexed: 0,
      no_faces: 0,
      faces_filtered: 0,
      error: 0
    }
  };
}

function mapPhotoIndexStatusRowsByPath(rows) {
  return new Map(rows.map((row) => [row.absolute_path, row]));
}

function loadPhotoIndexStatusRowsBySource(sourcePath) {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  return db
    .prepare(
      `
        SELECT absolute_path, indexed_status, last_indexed_at, last_error
        FROM ${PHOTO_INDEX_STATUS_TABLE}
        WHERE source_path = ?
      `
    )
    .all(normalizedSourcePath);
}

function loadPhotoIndexStatusRowsByPhotos(sourcePath, photos) {
  if (photos.length === 0) {
    return [];
  }

  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const uniquePaths = [...new Set(photos.map((photo) => photo.path).filter(Boolean))];
  const rows = [];

  for (let index = 0; index < uniquePaths.length; index += SQLITE_BIND_CHUNK_SIZE) {
    const chunk = uniquePaths.slice(index, index + SQLITE_BIND_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...db
        .prepare(
          `
            SELECT absolute_path, indexed_status, last_indexed_at, last_error
            FROM ${PHOTO_INDEX_STATUS_TABLE}
            WHERE source_path = ?
              AND absolute_path IN (${placeholders})
          `
        )
        .all(normalizedSourcePath, ...chunk)
    );
  }

  return rows;
}

function collectPhotoStatusMatches(photos, statusByPath, statusFilter) {
  const counts = {
    all: photos.length,
    pending: 0,
    indexed: 0,
    no_faces: 0,
    faces_filtered: 0,
    error: 0
  };
  const matchingPhotos = [];

  for (const photo of photos) {
    const status = getPhotoFilterStatusFromIndexRow(statusByPath.get(photo.path));
    counts[status] += 1;
    if (statusFilter === "all" || status === statusFilter) {
      matchingPhotos.push(photo);
    }
  }

  return { matchingPhotos, statusCounts: counts };
}

function addIndexStatusToPhoto(photo, status) {
  return {
    ...photo,
    indexedStatus: getPublicIndexedStatusFromIndexRow(status),
    lastIndexedAt: Number.isFinite(Number(status?.last_indexed_at)) ? Number(status.last_indexed_at) : null,
    lastError: status?.last_error ? String(status.last_error) : null
  };
}

function addIndexStatusToPhotos(photos, statusByPath = null) {
  if (photos.length === 0) {
    return photos;
  }

  if (statusByPath) {
    return photos.map((photo) => addIndexStatusToPhoto(photo, statusByPath.get(photo.path)));
  }

  const placeholders = photos.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT absolute_path, indexed_status, last_indexed_at, last_error
        FROM ${PHOTO_INDEX_STATUS_TABLE}
        WHERE absolute_path IN (${placeholders})
      `
    )
    .all(...photos.map((photo) => photo.path));
  const loadedStatusByPath = new Map(rows.map((row) => [row.absolute_path, row]));

  return photos.map((photo) => addIndexStatusToPhoto(photo, loadedStatusByPath.get(photo.path)));
}

async function readImageFilesFromSourcePath(sourcePath) {
  const sourceRoot = normalizeSourcePath(sourcePath);
  const queue = [sourceRoot];
  const photos = [];

  while (queue.length > 0) {
    const currentDirectory = queue.shift();
    let entries = [];

    try {
      entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!SOURCE_IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      photos.push({
        name: entry.name,
        path: fullPath,
        url: getSourcePhotoUrl(fullPath),
        thumbUrl: getSourceThumbnailUrl(fullPath),
        searchText: `${entry.name}\n${fullPath}`.toLowerCase()
      });
    }
  }

  photos.sort((a, b) => a.path.localeCompare(b.path));
  return photos;
}

async function getCachedSourcePhotos(sourcePath, { refresh = false } = {}) {
  const sourceRoot = normalizeSourcePath(sourcePath);
  const now = Date.now();
  const hasCurrentCache =
    photoListCache.sourcePath &&
    normalizeComparablePath(photoListCache.sourcePath) === normalizeComparablePath(sourceRoot) &&
    now - photoListCache.loadedAt < PHOTO_LIST_CACHE_MAX_AGE_MS;

  if (!refresh && hasCurrentCache) {
    return photoListCache.photos;
  }

  const photos = await readImageFilesFromSourcePath(sourceRoot);
  photoListCache = { sourcePath: sourceRoot, loadedAt: now, photos };
  return photos;
}

function toPublicPhoto(photo) {
  return {
    name: photo.name,
    path: photo.path,
    url: photo.url,
    thumbUrl: photo.thumbUrl
  };
}

async function listImageFilesFromSourcePath(sourcePath, options = {}) {
  const offset = clampInteger(options.offset, 0, { min: 0 });
  const limit = clampInteger(options.limit, DEFAULT_PHOTOS_PAGE_SIZE, {
    min: 1,
    max: MAX_PHOTOS_PAGE_SIZE
  });
  const query = normalizeSearchQuery(options.query);
  const statusFilter = normalizePhotoStatusFilter(options.statusFilter ?? options.status);

  const photos = await getCachedSourcePhotos(sourcePath, { refresh: Boolean(options.refresh) });
  const queriedPhotos = query
    ? photos.filter((photo) => photo.searchText.includes(query))
    : photos;
  const statusRows = query
    ? loadPhotoIndexStatusRowsByPhotos(sourcePath, queriedPhotos)
    : loadPhotoIndexStatusRowsBySource(sourcePath);
  const statusByPath = mapPhotoIndexStatusRowsByPath(statusRows);
  const { matchingPhotos, statusCounts } = collectPhotoStatusMatches(queriedPhotos, statusByPath, statusFilter);
  const total = matchingPhotos.length;
  const pagePhotos = matchingPhotos.slice(offset, offset + limit).map(toPublicPhoto);
  const indexSummary = query
    ? getPhotoIndexSummary(sourcePath, photos.length)
    : createPhotoIndexSummaryFromStatusRows(statusRows, photos.length);

  return {
    photos: addIndexStatusToPhotos(pagePhotos, statusByPath),
    total,
    offset,
    limit,
    hasMore: offset + pagePhotos.length < total,
    query,
    statusFilter,
    statusCounts,
    sourceTotal: photos.length,
    searchedTotal: queriedPhotos.length,
    indexSummary
  };
}

function clearFaceIndex() {
  resetThumbnailPrewarmQueue();
  const indexDir = getFaceIndexDir();
  fs.rmSync(indexDir, { recursive: true, force: true });
  fs.rmSync(getThumbnailCacheDir(), { recursive: true, force: true });

  const sourcePath = getSourcePathFromConfiguration({ required: false });
  if (sourcePath) {
    db.prepare(`DELETE FROM ${PHOTO_INDEX_STATUS_TABLE} WHERE source_path = ?`).run(sourcePath);
  } else {
    db.prepare(`DELETE FROM ${PHOTO_INDEX_STATUS_TABLE}`).run();
  }

  playerPreviewPayload = { photos: [], updatedAt: Date.now() };
  persistPlayerPreviewPayload(playerPreviewPayload);
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send("player:preview-photos", playerPreviewPayload);
  }

  return {
    cleared: true,
    indexDir,
    thumbnailCacheDir: getThumbnailCacheDir(),
    sourcePath,
    updatedAt: Date.now()
  };
}

function registerIpc() {
  pythonBridge.onProgress((payload) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("python:progress", payload);
    });
  });

  ipcMain.handle("config:set-source-path", async (_event, payload) => {
    const sourcePath = normalizeSourcePath(payload?.value);
    setConfigurationValue(SOURCE_PATH_CONFIG_KEY, sourcePath);
    clearPhotoListCache();
    const watchStatus = startSourcepadWatcher(sourcePath);
    return { key: SOURCE_PATH_CONFIG_KEY, value: sourcePath, watchStatus };
  });

  ipcMain.handle("config:get-source-path", async () => {
    const value = getSourcePathFromConfiguration({ required: false });
    return {
      key: SOURCE_PATH_CONFIG_KEY,
      value,
      rawValue: getConfigurationValue(SOURCE_PATH_CONFIG_KEY)
    };
  });

  ipcMain.handle("config:pick-source-path", async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow() || null;
    const result = await dialog.showOpenDialog(focusedWindow, {
      title: "Seleccionar carpeta sourcepad",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true, value: null };
    }

    const value = normalizeSourcePath(result.filePaths[0]);
    return { canceled: false, value };
  });

  ipcMain.handle("sourcepad:get-watch-status", async () => {
    return startSourcepadWatcherFromConfiguration();
  });

  ipcMain.handle("sourcepad:rescan", async (_event, payload) => {
    const sourcePath = getSourcePathFromConfiguration({ required: true });
    if (!sourcepadWatcher) {
      startSourcepadWatcher(sourcePath);
    }
    return rescanSourcepad({
      sourcePath,
      reason: payload?.reason ? String(payload.reason) : "manual"
    });
  });

  ipcMain.handle("config:list-source-photos", async (_event, payload) => {
    const sourcePath = getSourcePathFromConfiguration({ required: true });
    const result = await listImageFilesFromSourcePath(sourcePath, payload || {});
    const thumbnailPrewarm = queueThumbnailPrewarm(result.photos, sourcePath, {
      reason: "config:list-source-photos",
      limit: result.photos.length
    });
    return {
      sourcePath,
      count: result.photos.length,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      hasMore: result.hasMore,
      query: result.query,
      statusFilter: result.statusFilter,
      statusCounts: result.statusCounts,
      sourceTotal: result.sourceTotal,
      searchedTotal: result.searchedTotal,
      indexSummary: result.indexSummary,
      thumbnailPrewarm,
      photos: result.photos
    };
  });

  ipcMain.handle("index:get-status", async () => {
    const sourcePath = getSourcePathFromConfiguration({ required: false });
    if (!sourcePath) {
      return {
        sourcePath: null,
        indexDir: getFaceIndexDir(),
        summary: createEmptyPhotoIndexSummary()
      };
    }

    const photos = await getCachedSourcePhotos(sourcePath);
    return {
      sourcePath,
      indexDir: getFaceIndexDir(),
      summary: getPhotoIndexSummary(sourcePath, photos.length)
    };
  });

  ipcMain.handle("index:clear", async () => clearFaceIndex());

  ipcMain.handle("photos:open-external", async (_event, payload) => {
    const photoPath = typeof payload?.path === "string" ? payload.path : "";
    const result = validateSourceImagePath(photoPath);
    if (!result.ok) {
      throw new Error("La foto no existe o esta fuera de la carpeta sourcepad configurada.");
    }

    const openError = await shell.openPath(result.realPhotoPath);
    if (openError) {
      throw new Error(openError);
    }
    return { opened: true, path: result.realPhotoPath };
  });

  ipcMain.handle("player:set-preview-photos", async (_event, payload) => {
    const photos = sanitizePlayerPreviewPhotos(payload?.photos);

    playerPreviewPayload = {
      photos,
      updatedAt: Date.now()
    };
    persistPlayerPreviewPayload(playerPreviewPayload);

    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.webContents.send("player:preview-photos", playerPreviewPayload);
      if (playerWindow.isMinimized()) {
        playerWindow.restore();
      }
      playerWindow.focus();
    }

    return {
      sent: true,
      count: photos.length,
      updatedAt: playerPreviewPayload.updatedAt
    };
  });

  ipcMain.handle("player:get-preview-photos", async () => playerPreviewPayload);

  ipcMain.handle("python:request", async (_event, payload) => {
    const { action, data } = payload || {};
    if (!action) {
      throw new Error("Missing action in payload.");
    }
    if (!PYTHON_ACTIONS.has(action)) {
      throw new Error(`Unsupported Python action: ${String(action)}`);
    }

    const appDataPath = app.getPath("userData");
    let sourcePath = data?.sourcePath || null;
    if (action === "index_photos") {
      sourcePath = sourcePath
        ? normalizeSourcePath(sourcePath)
        : getSourcePathFromConfiguration({ required: true });
    }

    const runtimeData = {
      appDataPath,
      indexDir: getFaceIndexDir()
    };

    const mergedData = {
      ...(data || {}),
      ...(sourcePath ? { sourcePath } : {}),
      __runtime: {
        ...((data && data.__runtime) || {}),
        ...runtimeData
      }
    };

    const response = await pythonBridge.sendToPython(action, mergedData);
    if (action === "index_photos" && response?.ok) {
      const manifestPath = response?.result?.manifestPath;
      if (!manifestPath) {
        throw new Error("Python index_photos response did not include manifestPath.");
      }
      syncPhotoIndexStatusFromManifest(sourcePath, manifestPath);
      clearPhotoListCache(sourcePath);
    }

    return response;
  });
}

function handleFatalStartupError(error) {
  console.error("[main] Fatal startup error:", error);
  dialog.showErrorBox(
    "Error al iniciar la aplicación",
    `La aplicación no pudo iniciarse y se cerrará.\n\nDetalle: ${String(error?.stack || error?.message || error)}`
  );
  app.quit();
}

process.on("uncaughtException", (error) => {
  console.error("[main] Uncaught exception:", error);
  try {
    dialog.showErrorBox(
      "Error inesperado",
      `Ocurrió un error inesperado y la aplicación se cerrará.\n\nDetalle: ${String(error?.stack || error?.message || error)}`
    );
  } catch {
    // dialog may not be usable this early; the console log above is the fallback.
  }
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled promise rejection:", reason);
});

app.whenReady().then(() => {
  try {
    app.setAppUserModelId("com.lifibav3.desktop");
    registerSourcePhotoProtocol();
    registerSourceThumbnailProtocol();
    createDatabase();
    loadPlayerPreviewPayloadFromConfiguration();
    pythonBridge = createPythonBridge();
    pythonBridge.start();
    registerIpc();
    createAppWindows();
    startSourcepadWatcherFromConfiguration();
  } catch (error) {
    handleFatalStartupError(error);
  }
}).catch(handleFatalStartupError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopSourcepadWatcher();
  resetThumbnailPrewarmQueue();
  if (pythonBridge) {
    pythonBridge.stop();
  }
  if (db) {
    db.close();
  }
});
