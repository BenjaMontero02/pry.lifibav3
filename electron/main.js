const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const fs = require("fs");
const { createHash } = require("crypto");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, screen, session, shell } = require("electron");
const Database = require("better-sqlite3");
const { createPythonBridge } = require("./python-bridge");
const { printPhotos } = require("./print-service");

let db = null;
let pythonBridge = null;
let operatorWindow = null;
let playerWindow = null;
let playerPreviewPayload = { photos: [], updatedAt: null };
let photoListCache = { sourcePath: null, loadedAt: 0, photos: [] };
// Se incrementa en cada invalidacion: un listado que empezo antes no se cachea.
let photoListCacheGeneration = 0;
let photoIndexStatusVersion = 0;
let photoIndexStatusRowsCache = { version: -1, sourceKey: null, rows: null };
let photoIndexPipelineBusy = false;
let sourcepadWatcher = null;
let sourcepadRescanTimer = null;
let sourcepadRescanInFlight = null;
// Se incrementa con cada cambio detectado: el scan compara contra el valor de su inicio.
let sourcepadEventSeq = 0;
// Hubo un cambio mientras corria un scan: al terminar hay que correr otro.
let sourcepadRescanPending = false;
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
const INDEX_FACE_SIZE_CONFIG_KEY = "index.faceSizePx";
const INDEX_FACE_DET_SCORE_CONFIG_KEY = "index.faceDetScore";
// Calidad minima (norma AdaFace) de las caras que puede devolver una busqueda. 0 = apagado.
const INDEX_MIN_FACE_QUALITY_CONFIG_KEY = "index.minFaceQuality";
const MIN_FACE_QUALITY_MAX = 30;
// "precise" agrega una pasada del detector a mayor resolucion en fotos grandes:
// encuentra caras mas chicas a cambio de un analisis 1.5-3 veces mas lento.
const INDEX_DETECTION_MODE_CONFIG_KEY = "index.detectionMode";
const DETECTION_MODES = ["standard", "precise"];
const MAX_SCAN_PROMPT_CHARS = 120;
const SOURCE_PHOTO_SCHEME = "sourcephoto";
const SOURCE_THUMB_SCHEME = "sourcethumb";
const PHOTO_INDEX_STATUS_TABLE = "photo_index_status";
const PYTHON_ACTIONS = new Set(["ping", "index_photos", "find_player", "preview_face"]);
const DEFAULT_PHOTOS_PAGE_SIZE = 160;
const MAX_PHOTOS_PAGE_SIZE = 500;
const PHOTO_LIST_CACHE_MAX_AGE_MS = 30_000;
const SOURCEPAD_RESCAN_DEBOUNCE_MS = 900;
const THUMBNAIL_PREWARM_CONCURRENCY = 2;
const THUMBNAIL_PREWARM_RESCAN_LIMIT = 240;
const THUMBNAIL_PREWARM_PROGRESS_INTERVAL_MS = 600;
const SQLITE_BIND_CHUNK_SIZE = 900;
// Cache de miniaturas: al pasar el tope se borran las mas viejas hasta 80% del tope.
const THUMBNAIL_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const THUMBNAIL_CACHE_PRUNE_EVERY_WRITES = 100;
// Lado mayor de la miniatura. Va en la clave del cache: las de otro tamano no se reusan.
const THUMBNAIL_SIZE_PX = 512;
let thumbnailWritesSincePrune = 0;
let thumbnailPrunePromise = null;
// Permisos del navegador que se conceden a las ventanas propias. "media" es la camara
// (getUserMedia y los labels de enumerateDevices); "fullscreen" lo usa el jugador.
const APP_GRANTED_PERMISSIONS = new Set(["media", "fullscreen"]);
const PHOTO_STATUS_FILTERS = new Set(["all", "pending", "indexed", "no_faces", "faces_filtered", "error"]);
// Tiene que coincidir con IMAGE_EXTENSIONS de python/app/services/file_service.py:
// una extension que se lista aca pero Python no indexa queda "pendiente" para
// siempre. HEIC/HEIF no estan porque el backend no los puede decodificar.
const SOURCE_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".tif",
  ".tiff"
]);

function isSourceImageName(fileName) {
  // "._foto.jpg" son metadatos de macOS (AppleDouble); Python tampoco los indexa.
  if (String(fileName || "").startsWith("._")) {
    return false;
  }
  return SOURCE_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function normalizeComparablePath(value) {
  return path.resolve(value || "").toLowerCase();
}

function isPathInsideDirectory(filePath, directoryPath) {
  const file = path.resolve(filePath || "");
  const root = path.resolve(directoryPath || "");
  const relativePath = path.relative(root, file);
  // "..foo" es un nombre valido dentro de la carpeta: solo rechazar ".." como segmento.
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
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
  photoListCacheGeneration += 1;
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
  sourcepadEventSeq += 1;
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
    // Sin segundo scan en paralelo: el en vuelo puede haber listado antes del cambio,
    // asi que al terminar se corre otro (ver finally).
    sourcepadRescanPending = true;
    return sourcepadRescanInFlight.promise;
  }

  const eventSeqAtStart = sourcepadEventSeq;
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

    // Si llego un cambio despues de iniciar el scan, el listado puede estar viejo:
    // no se limpia dirty (el scan pendiente lo limpia).
    const changedDuringScan = eventSeqAtStart !== sourcepadEventSeq;
    if (stillCurrent && !changedDuringScan) {
      sourcepadWatchState.dirty = false;
    }

    const payload = {
      sourcePath,
      reason: options.reason || "manual",
      dirty: Boolean(sourcepadWatchState.dirty),
      stale: !stillCurrent,
      changedAt: sourcepadWatchState.lastChangedAt,
      scannedAt,
      sourceTotal: photos.length,
      indexSummary: summary,
      thumbnailPrewarm: prewarm
    };

    if (stillCurrent) {
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
      if (sourcepadRescanPending) {
        sourcepadRescanPending = false;
        const watchedSourcePath = sourcepadWatchState.sourcePath;
        if (
          watchedSourcePath &&
          normalizeComparablePath(watchedSourcePath) === sourceKey
        ) {
          scheduleSourcepadRescan("pending-after-scan");
        }
      }
    }
  }
}

function stopSourcepadWatcher() {
  sourcepadWatchToken += 1;
  sourcepadRescanPending = false;
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

  try {
    transaction();
  } finally {
    invalidatePhotoIndexStatusCache();
  }
}

// Migraciones numeradas por PRAGMA user_version. La posicion N+1 es la version N+1.
// Son idempotentes: una base previa a user_version tiene user_version 0 pero ya trae
// las tablas, asi que la migracion 1 solo las crea si faltan.
const DATABASE_MIGRATIONS = [
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS configuration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "key" TEXT NOT NULL UNIQUE,
        "value" TEXT
      )
    `);
    createPhotoIndexStatusTable();
  }
];

function runDatabaseMigrations() {
  const currentVersion = Number(db.pragma("user_version", { simple: true })) || 0;
  if (currentVersion > DATABASE_MIGRATIONS.length) {
    console.warn(
      `[main] app.sqlite tiene user_version ${currentVersion}, mayor que la app (${DATABASE_MIGRATIONS.length}).`
    );
    return;
  }

  for (let version = currentVersion; version < DATABASE_MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      DATABASE_MIGRATIONS[version]();
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

function createDatabase() {
  const dbPath = path.join(app.getPath("userData"), "app.sqlite");
  db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  // Con WAL, synchronous = NORMAL es seguro frente a corrupcion y evita un fsync por escritura.
  db.pragma("synchronous = NORMAL");
  const journalMode = String(db.pragma("journal_mode", { simple: true }) || "").toLowerCase();
  if (journalMode !== "wal") {
    console.warn(`[main] app.sqlite no quedo en WAL (journal_mode: ${journalMode}).`);
  }
  runDatabaseMigrations();
}

// Cache de las filas de estado de un source. Se invalida en cada escritura de
// photo_index_status (sync desde el manifest y limpieza del indice).
function invalidatePhotoIndexStatusCache() {
  photoIndexStatusVersion += 1;
  photoIndexStatusRowsCache = { version: -1, sourceKey: null, rows: null };
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

// Con un solo monitor el jugador va en una ventana normal a la derecha del area de
// trabajo, y el operador ocupa el resto: ninguna tapa a la otra.
const SINGLE_DISPLAY_PLAYER_WIDTH_RATIO = 0.4;

function getOtherDisplay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((display) => display.id !== primaryDisplay.id) || null;
}

function getOperatorBounds() {
  if (getOtherDisplay()) {
    return screen.getPrimaryDisplay().bounds;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const playerWidth = Math.round(workArea.width * SINGLE_DISPLAY_PLAYER_WIDTH_RATIO);
  return { x: workArea.x, y: workArea.y, width: workArea.width - playerWidth, height: workArea.height };
}

function getPlayerBounds() {
  const otherDisplay = getOtherDisplay();
  if (otherDisplay) {
    return otherDisplay.bounds;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * SINGLE_DISPLAY_PLAYER_WIDTH_RATIO);
  return { x: workArea.x + workArea.width - width, y: workArea.y, width, height: workArea.height };
}

function createAppWindows() {
  operatorWindow = createWindow("operator", getOperatorBounds());
  playerWindow = createWindow("player", getPlayerBounds());
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function isBoundsVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some((display) => rectsIntersect(bounds, display.workArea));
}

// Si un monitor se desconecta, la ventana que quedo en el fuera de pantalla se reubica.
function relocateOffscreenWindows() {
  if (operatorWindow && !operatorWindow.isDestroyed() && !isBoundsVisibleOnSomeDisplay(operatorWindow.getBounds())) {
    operatorWindow.setBounds(getOperatorBounds());
  }
  if (playerWindow && !playerWindow.isDestroyed() && !isBoundsVisibleOnSomeDisplay(playerWindow.getBounds())) {
    playerWindow.setBounds(getPlayerBounds());
  }
}

function focusOperatorWindow() {
  if (!operatorWindow || operatorWindow.isDestroyed()) {
    return;
  }
  if (operatorWindow.isMinimized()) {
    operatorWindow.restore();
  }
  operatorWindow.show();
  operatorWindow.focus();
}

// Solo las ventanas propias (archivos de la app o el dev server) reciben permisos,
// y solo los de APP_GRANTED_PERMISSIONS. El resto se niega.
function configureSessionPermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (!webContents || !APP_GRANTED_PERMISSIONS.has(permission)) {
      return false;
    }
    return isAllowedNavigationUrl(webContents.getURL());
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL() || "";
    callback(APP_GRANTED_PERMISSIONS.has(permission) && isAllowedNavigationUrl(requestingUrl));
  });
}

function normalizeSourcePath(value) {
  if (typeof value !== "string") {
    throw new Error("Source path must be a string.");
  }

  // path.resolve("") devuelve el cwd del proceso: validar antes de resolver o
  // una ruta vacia (o relativa) termina apuntando a la carpeta de la app.
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Source path cannot be empty.");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Source path must be absolute: ${trimmed}`);
  }

  const normalized = path.resolve(trimmed);
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
    .map((photo) => {
      const photoPath = String(photo.photoPath || "");
      return {
        photoPath,
        // Las URLs las arma main a partir de photoPath: el renderer no elige a que apunta
        // el jugador. thumbUrl es la miniatura de la grilla; url, la foto completa.
        url: photoPath ? getSourcePhotoUrl(photoPath) : "",
        thumbUrl: photoPath ? getSourceThumbnailUrl(photoPath) : "",
        similarity: Number.isFinite(Number(photo.similarity)) ? Number(photo.similarity) : null,
        displayNumber: Number.isFinite(Number(photo.displayNumber)) ? Number(photo.displayNumber) : null
      };
    })
    .filter((photo) => photo.photoPath);
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

// Cobertura de calidad del indice para Ajustes: cuantas caras la tienen y si el
// backend guardado es AdaFace (InsightFace nunca la tiene). null si no se pudo leer.
async function readIndexQualityCoverage() {
  try {
    // Solo el manifest: vectors.json puede pesar cientos de MB y parsearlo en el
    // proceso principal congelaba la app al abrir Ajustes. Python resume la
    // cobertura en `quality_coverage` cada vez que guarda los vectores.
    const manifestRaw = await fs.promises.readFile(
      path.join(getFaceIndexDir(), "photos_manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestRaw);
    const coverage = manifest?.quality_coverage;
    const embeddingModel = typeof manifest?.embedding_model === "string" ? manifest.embedding_model : "";
    if (!coverage || !Number.isFinite(coverage.faces) || !Number.isFinite(coverage.withQuality)) {
      // Indice armado antes de guardar calidad: se trata como sin calidad.
      return { faces: 0, withQuality: 0, qualityBackend: embeddingModel.startsWith("adaface"), unknown: true };
    }
    return {
      faces: coverage.faces,
      withQuality: coverage.withQuality,
      qualityBackend: embeddingModel.startsWith("adaface")
    };
  } catch {
    return null;
  }
}

function getThumbnailCacheDir() {
  return path.join(app.getPath("userData"), "thumb-cache");
}

function getThumbnailCachePath(photoPath, stats) {
  const hash = createHash("sha1")
    .update(
      `${photoPath}|${String(stats.mtimeNs || stats.mtimeMs)}|${String(stats.size)}|${THUMBNAIL_SIZE_PX}`
    )
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

// Borra las miniaturas mas viejas (por fecha de escritura) cuando el cache pasa el tope.
async function pruneThumbnailCache() {
  const entries = [];
  let totalBytes = 0;

  const walk = async (directory) => {
    let items = [];
    try {
      items = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        try {
          const stats = await fs.promises.stat(fullPath);
          entries.push({ fullPath, size: stats.size, mtimeMs: stats.mtimeMs });
          totalBytes += stats.size;
        } catch {
          // Archivo borrado mientras se recorria.
        }
      }
    }
  };

  await walk(getThumbnailCacheDir());
  if (totalBytes <= THUMBNAIL_CACHE_MAX_BYTES) {
    return;
  }

  const targetBytes = THUMBNAIL_CACHE_MAX_BYTES * 0.8;
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries) {
    if (totalBytes <= targetBytes) {
      break;
    }
    try {
      await fs.promises.rm(entry.fullPath, { force: true });
      totalBytes -= entry.size;
    } catch {
      // Si no se puede borrar, se sigue con la siguiente.
    }
  }
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
    const thumbnail = await nativeImage.createThumbnailFromPath(realPhotoPath, {
      width: THUMBNAIL_SIZE_PX,
      height: THUMBNAIL_SIZE_PX
    });
    if (!thumbnail || thumbnail.isEmpty()) {
      return null;
    }

    const jpeg = thumbnail.toJPEG(82);
    await fs.promises.writeFile(cachePath, jpeg);
    thumbnailWritesSincePrune += 1;
    if (thumbnailWritesSincePrune >= THUMBNAIL_CACHE_PRUNE_EVERY_WRITES && !thumbnailPrunePromise) {
      thumbnailWritesSincePrune = 0;
      thumbnailPrunePromise = pruneThumbnailCache()
        .catch((error) => console.warn("[main] Thumbnail cache prune failed:", error))
        .finally(() => {
          thumbnailPrunePromise = null;
        });
    }
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

// Mensajes de error distintos que se devuelven al renderer. Cuando falla el
// indexado entero (modelo ausente, backend roto) todas las fotos comparten el
// mismo mensaje: con los primeros basta para diagnosticar sin abrir foto por foto.
const PHOTO_ERROR_SAMPLE_LIMIT = 3;

function toPhotoErrorSamples(countsByMessage) {
  return [...countsByMessage.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((left, right) => right.count - left.count || left.message.localeCompare(right.message))
    .slice(0, PHOTO_ERROR_SAMPLE_LIMIT);
}

function createPhotoErrorSamplesFromStatusRows(rows) {
  const countsByMessage = new Map();
  for (const row of rows) {
    const message = String(row?.last_error || "").trim();
    if (!message) {
      continue;
    }
    countsByMessage.set(message, (countsByMessage.get(message) || 0) + 1);
  }
  return toPhotoErrorSamples(countsByMessage);
}

function loadPhotoErrorSamples(sourcePath) {
  const rows = db
    .prepare(
      `
        SELECT last_error AS message, COUNT(*) AS count
        FROM ${PHOTO_INDEX_STATUS_TABLE}
        WHERE source_path = ?
          AND last_error IS NOT NULL
          AND TRIM(last_error) <> ''
        GROUP BY last_error
        ORDER BY count DESC
        LIMIT ${PHOTO_ERROR_SAMPLE_LIMIT}
      `
    )
    .all(normalizeSourcePath(sourcePath));

  return rows.map((row) => ({ message: String(row.message), count: Number(row.count || 0) }));
}

function createPhotoIndexSummaryFromGroupedRows(rows, totalPhotos = 0, errorSamples = []) {
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
    },
    errorSamples
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

  return createPhotoIndexSummaryFromGroupedRows(
    [...groupedRowsByStatus.values()],
    totalPhotos,
    createPhotoErrorSamplesFromStatusRows(rows)
  );
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

  return createPhotoIndexSummaryFromGroupedRows(
    rows,
    totalPhotos,
    loadPhotoErrorSamples(normalizedSourcePath)
  );
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
    },
    errorSamples: []
  };
}

// Las claves van normalizadas (path.resolve + minusculas): la letra de unidad o el
// casing de la carpeta pueden diferir entre lo que escribio Python y lo que listo el disco.
function mapPhotoIndexStatusRowsByPath(rows) {
  return new Map(rows.map((row) => [normalizeComparablePath(row.absolute_path), row]));
}

function getStatusForPhoto(statusByPath, photo) {
  return statusByPath.get(normalizeComparablePath(photo.path));
}

function loadPhotoIndexStatusRowsBySourceCached(sourcePath) {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const sourceKey = normalizeComparablePath(normalizedSourcePath);
  if (
    photoIndexStatusRowsCache.version === photoIndexStatusVersion &&
    photoIndexStatusRowsCache.sourceKey === sourceKey
  ) {
    return photoIndexStatusRowsCache.rows;
  }

  const rows = loadPhotoIndexStatusRowsBySource(normalizedSourcePath);
  photoIndexStatusRowsCache = { version: photoIndexStatusVersion, sourceKey, rows };
  return rows;
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
  // Comparacion sin distincion de mayusculas: lower() de SQLite solo pliega ASCII, y
  // el resultado se vuelve a comparar en JS con normalizeComparablePath.
  const uniquePaths = [...new Set(photos.map((photo) => normalizeComparablePath(photo.path)).filter(Boolean))];
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
              AND lower(absolute_path) IN (${placeholders})
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
    const status = getPhotoFilterStatusFromIndexRow(getStatusForPhoto(statusByPath, photo));
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
    return photos.map((photo) => addIndexStatusToPhoto(photo, getStatusForPhoto(statusByPath, photo)));
  }

  const placeholders = photos.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT absolute_path, indexed_status, last_indexed_at, last_error
        FROM ${PHOTO_INDEX_STATUS_TABLE}
        WHERE lower(absolute_path) IN (${placeholders})
      `
    )
    .all(...photos.map((photo) => normalizeComparablePath(photo.path)));
  const loadedStatusByPath = mapPhotoIndexStatusRowsByPath(rows);

  return photos.map((photo) => addIndexStatusToPhoto(photo, getStatusForPhoto(loadedStatusByPath, photo)));
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

      if (!isSourceImageName(entry.name)) {
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

  // Si hubo una invalidacion mientras se listaba (un cambio en la carpeta), este
  // listado puede ser anterior al cambio: se devuelve pero no se cachea.
  const generationAtStart = photoListCacheGeneration;
  const photos = await readImageFilesFromSourcePath(sourceRoot);
  if (generationAtStart === photoListCacheGeneration) {
    photoListCache = { sourcePath: sourceRoot, loadedAt: now, photos };
  }
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
    : loadPhotoIndexStatusRowsBySourceCached(sourcePath);
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
  invalidatePhotoIndexStatusCache();

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

// Campos de `data` que el renderer puede mandar a cada accion de Python.
const PYTHON_ACTION_DATA_FIELDS = {
  ping: [],
  index_photos: ["forceReindex"],
  find_player: ["frames", "frameGroups", "similarityThreshold", "maxResults", "queryExpansion"],
  preview_face: ["frame"]
};

function pickPythonActionData(action, data) {
  const source = data && typeof data === "object" ? data : {};
  const picked = {};
  for (const field of PYTHON_ACTION_DATA_FIELDS[action] || []) {
    if (source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked;
}

// Solo se devuelven coincidencias cuyo archivo existe y esta dentro de la carpeta
// configurada (realpath, para que un symlink no saque la foto de la carpeta).
async function keepMatchesInsideSourceFolder(matches, sourcePath) {
  const realSourceRoot = await fs.promises.realpath(sourcePath);
  const checks = await Promise.all(
    matches.map(async (match) => {
      const photoPath = typeof match?.photoPath === "string" ? match.photoPath : "";
      if (!photoPath || !SOURCE_IMAGE_EXTENSIONS.has(path.extname(photoPath).toLowerCase())) {
        return false;
      }
      try {
        const realPhotoPath = await fs.promises.realpath(path.resolve(photoPath));
        const stats = await fs.promises.stat(realPhotoPath);
        return stats.isFile() && isPathInsideDirectory(realPhotoPath, realSourceRoot);
      } catch {
        return false;
      }
    })
  );
  const keptMatches = matches.filter((_match, index) => checks[index]);
  return { matches: keptMatches, dropped: matches.length - keptMatches.length };
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

  ipcMain.handle("config:get-index-settings", async () => {
    const faceSizePx = getConfigurationValue(INDEX_FACE_SIZE_CONFIG_KEY);
    const faceDetScore = getConfigurationValue(INDEX_FACE_DET_SCORE_CONFIG_KEY);
    const minFaceQuality = Number(getConfigurationValue(INDEX_MIN_FACE_QUALITY_CONFIG_KEY));
    const detectionMode = getConfigurationValue(INDEX_DETECTION_MODE_CONFIG_KEY);
    return {
      faceSizePx: faceSizePx !== null ? Number(faceSizePx) : 28,
      faceDetScore: faceDetScore !== null ? Number(faceDetScore) : 0.50,
      minFaceQuality: Number.isFinite(minFaceQuality) && minFaceQuality > 0 ? minFaceQuality : 0,
      detectionMode: DETECTION_MODES.includes(detectionMode) ? detectionMode : "standard",
      indexQuality: await readIndexQualityCoverage()
    };
  });

  ipcMain.handle("config:set-index-settings", async (_event, payload) => {
    const faceSizePx = payload?.faceSizePx != null
      ? Math.max(10, Math.min(200, Math.round(Number(payload.faceSizePx))))
      : 28;
    const faceDetScore = payload?.faceDetScore != null
      ? Math.max(0.05, Math.min(0.99, Number(Number(payload.faceDetScore).toFixed(2))))
      : 0.50;
    // Valor no numerico (o ausente) se guarda como 0: filtro apagado.
    const requestedQuality = Number(payload?.minFaceQuality);
    const minFaceQuality = payload?.minFaceQuality != null && Number.isFinite(requestedQuality)
      ? Math.max(0, Math.min(MIN_FACE_QUALITY_MAX, Number(requestedQuality.toFixed(1))))
      : 0;
    const detectionMode = DETECTION_MODES.includes(payload?.detectionMode) ? payload.detectionMode : "standard";

    setConfigurationValue(INDEX_FACE_SIZE_CONFIG_KEY, String(faceSizePx));
    setConfigurationValue(INDEX_FACE_DET_SCORE_CONFIG_KEY, String(faceDetScore));
    setConfigurationValue(INDEX_MIN_FACE_QUALITY_CONFIG_KEY, String(minFaceQuality));
    setConfigurationValue(INDEX_DETECTION_MODE_CONFIG_KEY, detectionMode);

    return { faceSizePx, faceDetScore, minFaceQuality, detectionMode };
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

  ipcMain.handle("index:clear", async () => {
    if (photoIndexPipelineBusy) {
      throw new Error("Hay un indexado en curso; esperá a que termine para limpiar el índice.");
    }
    return clearFaceIndex();
  });

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

  ipcMain.handle("print:send", async (_event, payload) => {
    const requestedPhotos = Array.isArray(payload?.photos) ? payload.photos : [];
    const photoPaths = [];
    const seenPaths = new Set();
    let skipped = 0;

    for (const photo of requestedPhotos) {
      const candidatePath = typeof photo === "string" ? photo : String(photo?.photoPath || "");
      if (!candidatePath) {
        skipped += 1;
        continue;
      }

      const result = validateSourceImagePath(candidatePath);
      if (!result.ok) {
        skipped += 1;
        continue;
      }
      if (seenPaths.has(result.realPhotoPath)) {
        continue;
      }
      seenPaths.add(result.realPhotoPath);
      photoPaths.push(result.realPhotoPath);
    }

    if (photoPaths.length === 0) {
      throw new Error("Ninguna de las fotos seleccionadas existe dentro de la carpeta configurada.");
    }

    const parentWindow = operatorWindow && !operatorWindow.isDestroyed() ? operatorWindow : null;
    const result = await printPhotos({ photoPaths, parentWindow });

    return {
      ...result,
      count: photoPaths.length,
      skipped
    };
  });

  ipcMain.handle("player:set-preview-photos", async (_event, payload) => {
    const photos = sanitizePlayerPreviewPhotos(payload?.photos);

    // La pantalla del jugador descarta payloads con updatedAt <= al ultimo que
    // aplico: si el reloj del sistema retrocede, Date.now() solo no alcanza.
    const previousUpdatedAt = Number(playerPreviewPayload?.updatedAt) || 0;
    playerPreviewPayload = {
      photos,
      updatedAt: Math.max(Date.now(), previousUpdatedAt + 1)
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

  // Indicacion grande en la pantalla publica durante el escaneo en 3 angulos
  // ("Mira a la camara", "Gira a tu izquierda"...). null la borra. No enfoca la
  // ventana del jugador: el operador sigue usando el teclado.
  ipcMain.handle("player:set-scan-prompt", async (_event, payload) => {
    const rawText = typeof payload?.text === "string" ? payload.text.trim() : "";
    const text = rawText ? rawText.slice(0, MAX_SCAN_PROMPT_CHARS) : null;
    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.webContents.send("player:scan-prompt", { text });
    }
    return { sent: true, text };
  });

  ipcMain.handle("python:request", async (_event, payload) => {
    const { action, data } = payload || {};
    if (!action) {
      throw new Error("Missing action in payload.");
    }
    if (!PYTHON_ACTIONS.has(action)) {
      throw new Error(`Unsupported Python action: ${String(action)}`);
    }

    // Solo se envian los campos que cada accion acepta. El sourcePath nunca viene del
    // renderer sin validar: si llega, tiene que ser la carpeta configurada.
    const requestedData = pickPythonActionData(action, data);
    let sourcePath = null;
    // El indicador de la camara pide cada ~500 ms: detras de un indexado quedaria
    // encolado (y demoraria al escaneo que venga despues). Se contesta "ocupado".
    if (action === "preview_face" && photoIndexPipelineBusy) {
      return { ok: true, result: { busy: true } };
    }
    if (action !== "ping" && action !== "preview_face") {
      sourcePath = getSourcePathFromConfiguration({ required: true });
      if (data?.sourcePath !== undefined && data?.sourcePath !== null) {
        const requestedSourcePath = normalizeSourcePath(data.sourcePath);
        if (normalizeComparablePath(requestedSourcePath) !== normalizeComparablePath(sourcePath)) {
          throw new Error("La carpeta pedida no es la carpeta configurada para las fotos.");
        }
      }
    }

    const runtimeData = {
      appDataPath: app.getPath("userData"),
      indexDir: getFaceIndexDir()
    };

    const extra = {};
    if (action === "index_photos") {
      const faceSizePx = getConfigurationValue(INDEX_FACE_SIZE_CONFIG_KEY);
      const faceDetScore = getConfigurationValue(INDEX_FACE_DET_SCORE_CONFIG_KEY);
      if (faceSizePx !== null) {
        extra.minFaceSizePx = Number(faceSizePx);
      }
      if (faceDetScore !== null) {
        extra.minFaceDetScore = Number(faceDetScore);
      }
      if (getConfigurationValue(INDEX_DETECTION_MODE_CONFIG_KEY) === "precise") {
        extra.detectionMode = "precise";
      }
    }
    if (action === "find_player") {
      const minFaceQuality = Number(getConfigurationValue(INDEX_MIN_FACE_QUALITY_CONFIG_KEY));
      if (Number.isFinite(minFaceQuality) && minFaceQuality > 0) {
        extra.minFaceQuality = minFaceQuality;
      }
    }

    const mergedData = {
      ...requestedData,
      ...extra,
      ...(sourcePath ? { sourcePath } : {}),
      __runtime: runtimeData
    };

    if (action === "find_player") {
      const response = await pythonBridge.sendToPython(action, mergedData);
      const matches = response?.result?.matches;
      if (!Array.isArray(matches)) {
        return response;
      }
      // Python puede devolver fotos que se movieron o borraron desde el ultimo indexado,
      // o que quedaron fuera de la carpeta configurada: no se muestran.
      const { matches: keptMatches, dropped } = await keepMatchesInsideSourceFolder(matches, sourcePath);
      if (dropped > 0) {
        console.warn(`[main] find_player: descartadas ${dropped} coincidencias fuera de la carpeta o inexistentes.`);
      }
      return { ...response, result: { ...response.result, matches: keptMatches } };
    }

    if (action !== "index_photos") {
      return pythonBridge.sendToPython(action, mergedData);
    }

    // Un solo indexado a la vez: el segundo se rechaza en vez de encolarse en Python.
    if (photoIndexPipelineBusy) {
      throw new Error("Ya hay un indexado en curso; esperá a que termine antes de iniciar otro.");
    }
    photoIndexPipelineBusy = true;
    try {
      return await pythonBridge.sendToPython(action, mergedData);
    } finally {
      // Sincronizar tambien si la corrida fallo o dio timeout: Python guarda
      // checkpoints del manifest durante la corrida, y sin esto la lista de
      // fotos seguia mostrando el estado anterior. El flag se libera al final,
      // despues de la sincronizacion, para que no se limpie a mitad de camino.
      const manifestPath = path.join(getFaceIndexDir(), "photos_manifest.json");
      try {
        if (fs.existsSync(manifestPath)) {
          syncPhotoIndexStatusFromManifest(sourcePath, manifestPath);
        }
      } catch (syncError) {
        console.error("[main] Could not sync photo index status from manifest:", syncError);
      } finally {
        clearPhotoListCache(sourcePath);
        photoIndexPipelineBusy = false;
      }
    }
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

// Una segunda instancia no debe abrir otra base, otro Python ni otras ventanas:
// sale, y la primera trae la ventana del operador al frente.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusOperatorWindow();
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  try {
    app.setAppUserModelId("com.lifibav3.desktop");
    registerSourcePhotoProtocol();
    registerSourceThumbnailProtocol();
    configureSessionPermissions();
    createDatabase();
    loadPlayerPreviewPayloadFromConfiguration();
    pythonBridge = createPythonBridge();
    pythonBridge.start();
    registerIpc();
    createAppWindows();
    screen.on("display-added", relocateOffscreenWindows);
    screen.on("display-removed", relocateOffscreenWindows);
    screen.on("display-metrics-changed", relocateOffscreenWindows);
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
