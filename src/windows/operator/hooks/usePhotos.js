import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const PHOTOS_PAGE_SIZE = 160;
const SOURCEPAD_RELOAD_DEBOUNCE_MS = 350;
const SOURCEPAD_WATCH_STATUS_CHANNEL = "sourcepad:get-watch-status";
export const PHOTO_STATUS_FILTERS = Object.freeze([
  "all",
  "pending",
  "indexed",
  "no_faces",
  "faces_filtered",
  "error"
]);

export const EMPTY_PHOTO_STATUS_COUNTS = Object.freeze({
  all: 0,
  pending: 0,
  indexed: 0,
  no_faces: 0,
  faces_filtered: 0,
  error: 0
});

export const EMPTY_INDEX_SUMMARY = Object.freeze({
  totalPhotos: 0,
  trackedPhotos: 0,
  indexedPhotos: 0,
  photosWithoutFaces: 0,
  unreadablePhotos: 0,
  errorPhotos: 0,
  pendingPhotos: 0,
  statusCounts: EMPTY_PHOTO_STATUS_COUNTS,
  errorSamples: []
});

export const EMPTY_THUMBNAIL_PREWARM = Object.freeze({
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

export const EMPTY_SOURCEPAD_WATCH_STATUS = Object.freeze({
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
  updatedAt: null,
  thumbnailPrewarm: EMPTY_THUMBNAIL_PREWARM
});

function normalizeCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeNullableString(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : Boolean(fallback);
}

function normalizeLastEvent(value, fallback = null) {
  const event = value === undefined ? fallback : value;
  if (!event || typeof event !== "object") {
    return null;
  }

  const eventType = normalizeNullableString(event.eventType);
  const filename = normalizeNullableString(event.filename);
  const noticedAt = normalizeTimestamp(event.noticedAt);
  if (!eventType && !filename && !noticedAt) {
    return null;
  }

  return { eventType, filename, noticedAt };
}

function normalizeThumbnailPrewarm(value, fallback = EMPTY_THUMBNAIL_PREWARM) {
  const current = value || {};
  const previous = fallback || EMPTY_THUMBNAIL_PREWARM;

  return {
    sourcePath: normalizeNullableString(current.sourcePath, previous.sourcePath),
    reason: normalizeNullableString(current.reason, previous.reason),
    total: normalizeCount(current.total ?? previous.total),
    completed: normalizeCount(current.completed ?? previous.completed),
    failed: normalizeCount(current.failed ?? previous.failed),
    skipped: normalizeCount(current.skipped ?? previous.skipped),
    queued: normalizeCount(current.queued ?? previous.queued),
    active: normalizeCount(current.active ?? previous.active),
    running: normalizeCount(current.running ?? previous.running),
    inFlightCreations: normalizeCount(current.inFlightCreations ?? previous.inFlightCreations),
    pending: normalizeCount(current.pending ?? previous.pending),
    startedAt: normalizeTimestamp(current.startedAt ?? previous.startedAt),
    finishedAt: normalizeTimestamp(current.finishedAt ?? previous.finishedAt),
    updatedAt: normalizeTimestamp(current.updatedAt ?? previous.updatedAt)
  };
}

function normalizeSourcepadWatchStatus(value, fallback = EMPTY_SOURCEPAD_WATCH_STATUS) {
  const current = value || {};
  const previous = fallback || EMPTY_SOURCEPAD_WATCH_STATUS;
  const thumbnailPrewarm = normalizeThumbnailPrewarm(
    current.thumbnailPrewarm,
    previous.thumbnailPrewarm || EMPTY_THUMBNAIL_PREWARM
  );

  return {
    sourcePath: normalizeNullableString(current.sourcePath, previous.sourcePath),
    watching: normalizeBoolean(current.watching, previous.watching),
    recursive: normalizeBoolean(current.recursive, previous.recursive),
    dirty: normalizeBoolean(current.dirty, previous.dirty),
    pendingRescan: normalizeBoolean(current.pendingRescan, previous.pendingRescan),
    debounceMs: normalizeCount(current.debounceMs ?? previous.debounceMs),
    lastEvent: normalizeLastEvent(current.lastEvent, previous.lastEvent),
    lastChangedAt: normalizeTimestamp(current.lastChangedAt ?? previous.lastChangedAt),
    lastScannedAt: normalizeTimestamp(current.lastScannedAt ?? previous.lastScannedAt),
    lastError: normalizeNullableString(current.lastError, previous.lastError),
    updatedAt: normalizeTimestamp(current.updatedAt ?? previous.updatedAt),
    thumbnailPrewarm
  };
}

function normalizePhotoStatusFilter(value) {
  const statusFilter = String(value || "all").trim();
  return PHOTO_STATUS_FILTERS.includes(statusFilter) ? statusFilter : "all";
}

function normalizePhotoStatusCounts(value) {
  return PHOTO_STATUS_FILTERS.reduce((counts, statusFilter) => {
    counts[statusFilter] = Number(value?.[statusFilter] || 0);
    return counts;
  }, {});
}

function createPhotosMeta(statusFilter = "all") {
  return {
    total: 0,
    offset: 0,
    limit: PHOTOS_PAGE_SIZE,
    hasMore: false,
    query: "",
    statusFilter: normalizePhotoStatusFilter(statusFilter),
    statusCounts: EMPTY_PHOTO_STATUS_COUNTS,
    sourceTotal: 0,
    searchedTotal: 0,
    sourcepadWatchStatus: EMPTY_SOURCEPAD_WATCH_STATUS,
    thumbnailPrewarm: EMPTY_THUMBNAIL_PREWARM
  };
}

function getPhotosRequestOptions(eventOrOptions, maybeOptions) {
  if (eventOrOptions && typeof eventOrOptions.preventDefault === "function") {
    eventOrOptions.preventDefault();
    return maybeOptions || {};
  }
  return eventOrOptions || {};
}

export default function usePhotos({ desktopApi, activeView, persistedPath, onIndexCleared }) {
  const [photos, setPhotos] = useState([]);
  const [photosMeta, setPhotosMeta] = useState(() => createPhotosMeta());
  const [photosSearchDraft, setPhotosSearchDraft] = useState("");
  const [photosQuery, setPhotosQuery] = useState("");
  const [photosStatusFilter, setPhotosStatusFilter] = useState("all");
  const [photosReloadKey, setPhotosReloadKey] = useState(0);
  const [photosPath, setPhotosPath] = useState("");
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState("");
  const [photoIndexSummary, setPhotoIndexSummary] = useState(EMPTY_INDEX_SUMMARY);
  const [indexingPhotos, setIndexingPhotos] = useState(false);
  const [indexingMessage, setIndexingMessage] = useState("");
  const [indexingProgress, setIndexingProgress] = useState(null);
  const [clearingIndex, setClearingIndex] = useState(false);
  const [sourcepadWatchStatus, setSourcepadWatchStatus] = useState(() => EMPTY_SOURCEPAD_WATCH_STATUS);
  const photosScrollRef = useRef(null);
  const photosRequestIdRef = useRef(0);
  const photosLoadRafRef = useRef(0);
  const photosLastAutoloadAtRef = useRef(0);
  const sourcepadReloadTimeoutRef = useRef(0);
  const activeViewRef = useRef(activeView);
  const photosStatusFilterRef = useRef(photosStatusFilter);
  const loadPhotosRef = useRef(null);

  const loadPhotos = useCallback(async ({
    append = false,
    offset = 0,
    query = photosQuery,
    statusFilter = photosStatusFilter,
    refresh = false
  } = {}) => {
    const nextStatusFilter = normalizePhotoStatusFilter(statusFilter);
    const requestId = photosRequestIdRef.current + 1;
    photosRequestIdRef.current = requestId;
    setPhotosLoading(true);
    setPhotosError("");

    try {
      const result = await desktopApi.invoke("config:list-source-photos", {
        offset,
        limit: PHOTOS_PAGE_SIZE,
        query,
        statusFilter: nextStatusFilter,
        refresh
      });
      if (photosRequestIdRef.current !== requestId) {
        return;
      }
      const nextPhotos = result?.photos || [];
      const nextThumbnailPrewarm = normalizeThumbnailPrewarm(result?.thumbnailPrewarm);
      setPhotos((current) => {
        if (!append) {
          return nextPhotos;
        }
        if (current.length !== offset) {
          return current;
        }
        return [...current, ...nextPhotos];
      });
      setPhotosPath(result?.sourcePath || "");
      setPhotosMeta({
        total: Number(result?.total || 0),
        offset: Number(result?.offset || 0),
        limit: Number(result?.limit || PHOTOS_PAGE_SIZE),
        hasMore: Boolean(result?.hasMore),
        query: result?.query || "",
        statusFilter: normalizePhotoStatusFilter(result?.statusFilter),
        statusCounts: normalizePhotoStatusCounts(result?.statusCounts),
        sourceTotal: Number(result?.sourceTotal || 0),
        searchedTotal: Number(result?.searchedTotal || 0),
        thumbnailPrewarm: nextThumbnailPrewarm
      });
      setSourcepadWatchStatus((current) => {
        return normalizeSourcepadWatchStatus(
          {
            sourcePath: result?.sourcePath,
            updatedAt: nextThumbnailPrewarm.updatedAt || current.updatedAt,
            thumbnailPrewarm: nextThumbnailPrewarm
          },
          current
        );
      });
      setPhotoIndexSummary(result?.indexSummary || EMPTY_INDEX_SUMMARY);
    } catch (error) {
      if (photosRequestIdRef.current !== requestId) {
        return;
      }
      if (!append) {
        setPhotos([]);
        setPhotosPath("");
        setPhotosMeta(createPhotosMeta(nextStatusFilter));
        setPhotoIndexSummary(EMPTY_INDEX_SUMMARY);
      }
      setPhotosError(`No se pudieron cargar las fotos: ${String(error.message || error)}`);
    } finally {
      if (photosRequestIdRef.current === requestId) {
        setPhotosLoading(false);
      }
    }
  }, [desktopApi, photosQuery, photosStatusFilter]);

  const refreshSourcepadWatchStatus = useCallback(async () => {
    try {
      const result = await desktopApi.invoke(SOURCEPAD_WATCH_STATUS_CHANNEL);
      setSourcepadWatchStatus((current) => normalizeSourcepadWatchStatus(result, current));
    } catch (error) {
      const message = String(error.message || error);
      setSourcepadWatchStatus((current) => {
        return normalizeSourcepadWatchStatus(
          {
            lastError: message,
            updatedAt: Date.now()
          },
          current
        );
      });
    }
  }, [desktopApi]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    photosStatusFilterRef.current = photosStatusFilter;
  }, [photosStatusFilter]);

  useEffect(() => {
    loadPhotosRef.current = loadPhotos;
  }, [loadPhotos]);

  const scheduleSourcepadReload = useCallback(() => {
    if (sourcepadReloadTimeoutRef.current) {
      window.clearTimeout(sourcepadReloadTimeoutRef.current);
    }

    sourcepadReloadTimeoutRef.current = window.setTimeout(() => {
      sourcepadReloadTimeoutRef.current = 0;
      if (photosScrollRef.current) {
        photosScrollRef.current.scrollTop = 0;
      }

      if (activeViewRef.current !== "photos") {
        setPhotosReloadKey((current) => current + 1);
        return;
      }

      loadPhotosRef.current?.({
        refresh: true,
        statusFilter: photosStatusFilterRef.current
      });
    }, SOURCEPAD_RELOAD_DEBOUNCE_MS);
  }, []);

  const handleShowMorePhotos = useCallback(() => {
    if (!photosMeta.hasMore || photosLoading) {
      return;
    }
    loadPhotos({ append: true, offset: photos.length });
  }, [loadPhotos, photos.length, photosLoading, photosMeta.hasMore]);

  const hasMorePhotos = photosMeta.hasMore;
  const currentIndexSummary = photoIndexSummary || EMPTY_INDEX_SUMMARY;

  const indexingProgressPercent = useMemo(() => {
    const processed = Number(indexingProgress?.processed || 0);
    const total = Number(indexingProgress?.total || 0);
    if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
  }, [indexingProgress]);

  const indexingProgressLabel = useMemo(() => {
    if (!indexingProgress) {
      return "Preparando analisis...";
    }

    const processed = Number(indexingProgress.processed || 0);
    const total = Number(indexingProgress.total || 0);
    const statusText = String(indexingProgress.status || "procesando");
    const facesDetected = Number(indexingProgress.facesDetected || 0);
    const faceText = facesDetected > 0 ? ` - ${facesDetected} caras` : "";
    return `Analizando ${processed} de ${total} fotos.${faceText}`;
  }, [indexingProgress]);

  const handlePhotosSearchSubmit = useCallback((eventOrOptions, maybeOptions) => {
    const options = getPhotosRequestOptions(eventOrOptions, maybeOptions);
    const nextQuery =
      typeof options.query === "string"
        ? options.query.trim()
        : photosSearchDraft.trim();
    const nextStatusFilter = normalizePhotoStatusFilter(options.statusFilter ?? photosStatusFilter);

    setPhotosQuery(nextQuery);
    setPhotosStatusFilter(nextStatusFilter);
    setPhotosReloadKey((current) => current + 1);
    if (photosScrollRef.current) {
      photosScrollRef.current.scrollTop = 0;
    }
  }, [photosSearchDraft, photosStatusFilter]);

  const handleClearPhotosSearch = useCallback((options = {}) => {
    const nextStatusFilter = normalizePhotoStatusFilter(options.statusFilter ?? photosStatusFilter);
    setPhotosSearchDraft("");
    setPhotosQuery("");
    setPhotosStatusFilter(nextStatusFilter);
    setPhotosReloadKey((current) => current + 1);
    if (photosScrollRef.current) {
      photosScrollRef.current.scrollTop = 0;
    }
  }, [photosStatusFilter]);

  const handleClearIndex = useCallback(async () => {
    const confirmed = window.confirm(
      "Esto borra los datos de reconocimiento facial y limpia la pantalla del jugador. Las fotos originales no se eliminan. Continuar?"
    );
    if (!confirmed) {
      return;
    }

    setClearingIndex(true);
    setPhotosError("");
    setIndexingMessage("");

    try {
      await desktopApi.invoke("index:clear");
      onIndexCleared?.();
      setIndexingProgress(null);
      setIndexingMessage("Catalogo limpiado. Presiona 'Actualizar fotos' para volver a analizar.");
      await loadPhotos({ offset: 0, statusFilter: photosStatusFilter });
    } catch (error) {
      setPhotosError(`No se pudo limpiar el catalogo: ${String(error.message || error)}`);
    } finally {
      setClearingIndex(false);
    }
  }, [desktopApi, loadPhotos, onIndexCleared, photosStatusFilter]);

  const maybeLoadMorePhotos = useCallback(() => {
    const container = photosScrollRef.current;
    if (!container || photosLoading || !hasMorePhotos) {
      return;
    }

    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    const preloadThreshold = Math.max(260, container.clientHeight * 0.5);
    if (remaining > preloadThreshold) {
      return;
    }

    const now = Date.now();
    if (now - photosLastAutoloadAtRef.current < 220) {
      return;
    }

    photosLastAutoloadAtRef.current = now;
    handleShowMorePhotos();
  }, [hasMorePhotos, handleShowMorePhotos, photosLoading]);

  const handlePhotosScroll = useCallback(() => {
    if (photosLoadRafRef.current) {
      return;
    }

    photosLoadRafRef.current = window.requestAnimationFrame(() => {
      photosLoadRafRef.current = 0;
      maybeLoadMorePhotos();
    });
  }, [maybeLoadMorePhotos]);

  const handleIndexPhotos = useCallback(async ({ force = false } = {}) => {
    setIndexingPhotos(true);
    setIndexingMessage("");
    setIndexingProgress(null);
    setPhotosError("");

    try {
      const response = await desktopApi.sendToPython("index_photos", { forceReindex: force });
      const stats = response?.result?.stats || null;
      // Sin stats no hubo corrida: no se declara completo. Antes se mostraba
      // "Analisis completo." ante cualquier respuesta anomala, que es como el
      // fallo de carga de modelos quedaba invisible.
      if (!stats) {
        throw new Error(
          `el backend no devolvio el resultado de la corrida${
            response?.error ? `: ${response.error}` : "."
          }`
        );
      }
      setIndexingMessage(
        `Analisis completo: ${stats.processedPhotos} fotos revisadas, ${stats.newFacesIndexed} rostros encontrados.`
      );
      await loadPhotos({ refresh: true, statusFilter: photosStatusFilter });
    } catch (error) {
      setIndexingMessage("");
      setIndexingProgress(null);
      setPhotosError(`No se pudo completar el analisis: ${String(error.message || error)}`);
    } finally {
      setIndexingPhotos(false);
    }
  }, [desktopApi, loadPhotos, photosStatusFilter]);

  const handleReindexAll = useCallback(async () => {
    const confirmed = window.confirm(
      "Esto vuelve a analizar TODAS las fotos de la carpeta, incluidas las que ya estan listas. Puede demorar bastante. Continuar?"
    );
    if (!confirmed) {
      return;
    }

    await handleIndexPhotos({ force: true });
  }, [handleIndexPhotos]);

  const handleReloadPhotos = useCallback(async () => {
    await loadPhotos({ refresh: true, statusFilter: photosStatusFilter });
  }, [loadPhotos, photosStatusFilter]);

  useEffect(() => {
    maybeLoadMorePhotos();
  }, [photos.length, maybeLoadMorePhotos]);

  useEffect(() => {
    if (activeView !== "photos") {
      return;
    }

    loadPhotos({ statusFilter: photosStatusFilter });
  }, [activeView, loadPhotos, persistedPath, photosReloadKey, photosStatusFilter]);

  useEffect(() => {
    if (activeView !== "photos") {
      return;
    }

    refreshSourcepadWatchStatus();
  }, [activeView, persistedPath, refreshSourcepadWatchStatus]);

  useEffect(() => {
    const unsubscribe = desktopApi.on("python:progress", (event) => {
      if (event?.action !== "index_photos") {
        return;
      }
      setIndexingProgress(event.payload || null);
    });

    return () => {
      unsubscribe?.();
    };
  }, [desktopApi]);

  useEffect(() => {
    const unsubscribeChanged = desktopApi.on("sourcepad:changed", (event) => {
      if (event?.stale) {
        return;
      }
      setPhotosError("");
      setSourcepadWatchStatus((current) => {
        return normalizeSourcepadWatchStatus(
          event?.watchStatus || {
            sourcePath: event?.sourcePath,
            dirty: Boolean(event?.dirty),
            pendingRescan: false,
            lastChangedAt: event?.changedAt,
            lastScannedAt: event?.scannedAt,
            lastError: null,
            updatedAt: event?.scannedAt || Date.now(),
            thumbnailPrewarm: event?.thumbnailPrewarm
          },
          current
        );
      });
      scheduleSourcepadReload();
    });
    const unsubscribeWatchError = desktopApi.on("sourcepad:watch-error", (event) => {
      const message = event?.message || event?.error?.message || "error desconocido";
      setSourcepadWatchStatus((current) => {
        return normalizeSourcepadWatchStatus(
          event?.watchStatus || {
            sourcePath: event?.sourcePath,
            dirty: true,
            lastError: message,
            updatedAt: event?.updatedAt || Date.now()
          },
          {
            ...current,
            lastError: message
          }
        );
      });
      if (activeViewRef.current !== "photos") {
        return;
      }

      if (event?.reason !== "thumbnail-prewarm") {
        setPhotosError(`No se pudo monitorear la carpeta: ${message}`);
      }
    });
    const unsubscribeThumbnailProgress = desktopApi.on("sourcepad:thumbnail-progress", (event) => {
      setSourcepadWatchStatus((current) => {
        return normalizeSourcepadWatchStatus(
          {
            sourcePath: event?.sourcePath || current.sourcePath,
            updatedAt: event?.updatedAt || Date.now(),
            thumbnailPrewarm: event
          },
          current
        );
      });
    });

    return () => {
      unsubscribeChanged?.();
      unsubscribeWatchError?.();
      unsubscribeThumbnailProgress?.();
    };
  }, [desktopApi, scheduleSourcepadReload]);

  useEffect(() => {
    return () => {
      if (photosLoadRafRef.current) {
        window.cancelAnimationFrame(photosLoadRafRef.current);
      }
      if (sourcepadReloadTimeoutRef.current) {
        window.clearTimeout(sourcepadReloadTimeoutRef.current);
      }
    };
  }, []);

  const handleOpenPhoto = useCallback(
    async (photo) => {
      if (!photo?.path) {
        return;
      }

      try {
        const result = await desktopApi.invoke("photos:open-external", { path: photo.path });
        if (result?.browserFallback) {
          setPhotosError("Abrir fotos solo esta disponible dentro de la app de escritorio.");
        }
      } catch (error) {
        setPhotosError(`No se pudo abrir la foto: ${String(error.message || error)}`);
      }
    },
    [desktopApi]
  );

  const enrichedPhotosMeta = useMemo(() => {
    const currentWatchStatus = normalizeSourcepadWatchStatus(sourcepadWatchStatus);
    return {
      ...photosMeta,
      sourcepadWatchStatus: currentWatchStatus,
      thumbnailPrewarm: currentWatchStatus.thumbnailPrewarm || photosMeta.thumbnailPrewarm || EMPTY_THUMBNAIL_PREWARM
    };
  }, [photosMeta, sourcepadWatchStatus]);

  return {
    photos,
    photosMeta: enrichedPhotosMeta,
    photosSearchDraft,
    photosQuery,
    photosPath,
    photosLoading,
    photosError,
    indexingPhotos,
    indexingMessage,
    indexingProgressPercent,
    indexingProgressLabel,
    clearingIndex,
    currentIndexSummary,
    hasMorePhotos,
    photosScrollRef,
    setPhotosSearchDraft,
    handleIndexPhotos,
    handleReindexAll,
    handleReloadPhotos,
    handleClearIndex,
    handlePhotosSearchSubmit,
    handleClearPhotosSearch,
    handlePhotosScroll,
    handleShowMorePhotos,
    handleOpenPhoto
  };
}
