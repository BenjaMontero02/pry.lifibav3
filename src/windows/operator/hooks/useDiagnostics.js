import { useCallback, useEffect, useRef, useState } from "react";

const SOURCE_PHOTO_SAMPLE_LIMIT = 8;
const SOURCEPAD_WATCH_STATUS_CHANNEL = "sourcepad:get-watch-status";
const SOURCEPAD_RESCAN_CHANNEL = "sourcepad:rescan";

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

const INITIAL_DIAGNOSTICS = Object.freeze({
  loading: false,
  checkedAt: null,
  ipc: {
    ok: false,
    message: "Sin verificar",
    detail: ""
  },
  sourcepad: {
    configured: false,
    valid: false,
    path: "",
    rawPath: "",
    message: "Sin verificar",
    totalPhotos: 0,
    loadedPhotos: 0,
    samplePhotos: [],
    smoke: {
      ok: false,
      message: "Sin verificar",
      detail: ""
    },
    watch: {
      available: false,
      ok: false,
      message: "Sin verificar",
      detail: ""
    },
    rescan: {
      available: false,
      message: "Sin verificar",
      detail: ""
    }
  },
  index: {
    sourcePath: "",
    indexDir: "",
    summary: EMPTY_INDEX_SUMMARY,
    message: "Sin verificar"
  },
  preview: {
    photos: [],
    updatedAt: null,
    message: "Sin verificar"
  },
  rescanning: false,
  errors: []
});

function createSettled(value) {
  return { status: "fulfilled", value };
}

function createRejected(reason) {
  return { status: "rejected", reason };
}

function isUnsupportedIpcError(error) {
  const message = String(error?.message || error);
  return (
    message.includes("Unsupported IPC channel") ||
    message.includes("Unsupported browser fallback IPC channel") ||
    message.includes("No handler registered")
  );
}

function settle(callback) {
  return Promise.resolve()
    .then(callback)
    .then(createSettled, createRejected);
}

async function settleOptionalIpc(desktopApi, channel, payload) {
  const result = await settle(() => desktopApi.invoke(channel, payload));
  if (result.status === "fulfilled") {
    return { ...result, available: true };
  }

  return {
    ...result,
    available: !isUnsupportedIpcError(result.reason)
  };
}

function getErrorMessage(label, error) {
  return `${label}: ${String(error?.message || error)}`;
}

function getSettledError(label, result) {
  if (result.status === "fulfilled") {
    return "";
  }
  return getErrorMessage(label, result.reason);
}

function getOptionalSettledError(label, result) {
  if (!result?.available || result.status === "fulfilled") {
    return "";
  }
  return getErrorMessage(label, result.reason);
}

function getIpcFallbackError(pingResult) {
  if (pingResult.status !== "fulfilled" || !pingResult.value?.browserFallback) {
    return "";
  }
  return "Electron IPC: renderer usando fallback de navegador; el bridge de Electron no esta disponible.";
}

function getSourcepadConfigurationError(configResult) {
  if (configResult.status !== "fulfilled") {
    return "";
  }

  const result = configResult.value || {};
  if (!result.value && result.rawValue) {
    return "Sourcepad configurado: la ruta guardada no existe o no es valida.";
  }

  return "";
}

function getJsonDetail(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function getNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeSourcepadSmoke(configResult, photosResult) {
  const config = configResult.status === "fulfilled" ? configResult.value || {} : {};
  const configured = Boolean(config.value || config.rawValue);
  const valid = Boolean(config.value);

  if (!configured) {
    return {
      ok: false,
      message: "Smoke pendiente: no hay carpeta sourcepad configurada.",
      detail: ""
    };
  }

  if (!valid) {
    return {
      ok: false,
      message: "Smoke bloqueado: la ruta sourcepad guardada no es valida.",
      detail: String(config.rawValue || "")
    };
  }

  if (photosResult.status === "rejected") {
    return {
      ok: false,
      message: "Smoke fallo: no se pudo listar la carpeta sourcepad.",
      detail: String(photosResult.reason?.message || photosResult.reason)
    };
  }

  const result = photosResult.value || {};
  const total = getNumber(result.sourceTotal ?? result.total);
  const loaded = getNumber(result.count);

  return {
    ok: true,
    message: `Smoke OK: sourcepad respondio con ${loaded} fotos de muestra sobre ${total} detectadas.`,
    detail: result.sourcePath ? `Sourcepad: ${String(result.sourcePath)}` : ""
  };
}

function getWatchStatusMessage(value) {
  const status = String(value?.status || value?.state || "").trim();
  if (value?.available === false) {
    return status
      ? `Watch sourcepad deshabilitado, estado ${status}.`
      : "Watch sourcepad respondio, pero esta deshabilitado.";
  }

  if (value?.ok === false) {
    return status
      ? `Watch sourcepad disponible, estado ${status}.`
      : "Watch sourcepad disponible, pero informo un problema.";
  }

  if (value?.watching === true || value?.active === true || value?.enabled === true) {
    return status
      ? `Watch sourcepad activo, estado ${status}.`
      : "Watch sourcepad activo.";
  }

  if (status) {
    return `Watch sourcepad disponible, estado ${status}.`;
  }

  return "Watch sourcepad disponible.";
}

function getWatchRescanAvailable(value) {
  if (typeof value?.rescanAvailable === "boolean") {
    return value.rescanAvailable;
  }
  if (typeof value?.canRescan === "boolean") {
    return value.canRescan;
  }
  if (typeof value?.rescan === "boolean") {
    return value.rescan;
  }
  if (typeof value?.available === "boolean") {
    return value.available;
  }
  return true;
}

function normalizeSourcepadWatch(watchResult) {
  if (!watchResult?.available) {
    return {
      available: false,
      ok: false,
      message: "Watch/rescan no esta expuesto por este build.",
      detail: ""
    };
  }

  if (watchResult.status === "rejected") {
    return {
      available: true,
      ok: false,
      message: "Watch sourcepad no respondio.",
      detail: String(watchResult.reason?.message || watchResult.reason)
    };
  }

  const value = watchResult.value || {};
  return {
    available: true,
    ok: value.ok !== false && value.available !== false,
    message: getWatchStatusMessage(value),
    detail: getJsonDetail(value)
  };
}

function normalizeSourcepadRescanAvailability(watchResult) {
  if (!watchResult?.available || watchResult.status === "rejected") {
    return {
      available: false,
      message: "Rescan sourcepad no disponible en este build.",
      detail: ""
    };
  }

  const value = watchResult.value || {};
  const available = getWatchRescanAvailable(value);
  return {
    available,
    message: available ? "Rescan sourcepad disponible." : "Rescan sourcepad deshabilitado por el watch actual.",
    detail: ""
  };
}

function normalizeSourcepadRescanResult(rescanResult) {
  if (!rescanResult?.available) {
    return {
      available: false,
      message: "Rescan sourcepad no disponible en este build.",
      detail: ""
    };
  }

  if (rescanResult.status === "rejected") {
    return {
      available: true,
      message: "No se pudo ejecutar rescan sourcepad.",
      detail: String(rescanResult.reason?.message || rescanResult.reason)
    };
  }

  return {
    available: true,
    message: "Rescan sourcepad ejecutado; diagnostico refrescado.",
    detail: getJsonDetail(rescanResult.value || {})
  };
}

function normalizeSourcepad(configResult, photosResult, watchResult) {
  const config = configResult.status === "fulfilled" ? configResult.value || {} : {};
  const photos = photosResult.status === "fulfilled" ? photosResult.value || {} : {};
  const path = config.value || "";
  const rawPath = config.rawValue || "";
  const configured = Boolean(path || rawPath);
  const valid = Boolean(path);
  const samplePhotos = Array.isArray(photos.photos) ? photos.photos : [];
  const totalPhotos = getNumber(photos.sourceTotal ?? photos.total);

  let message = "No hay carpeta sourcepad configurada.";
  if (valid) {
    message = `Sourcepad valido con ${totalPhotos} fotos detectadas.`;
  } else if (rawPath) {
    message = "La ruta sourcepad guardada no existe o no es valida.";
  }

  if (photosResult.status === "rejected") {
    message = valid ? "Sourcepad configurado, pero no se pudo listar la muestra." : message;
  }

  return {
    configured,
    valid,
    path,
    rawPath,
    message,
    totalPhotos,
    loadedPhotos: getNumber(photos.count || samplePhotos.length || 0),
    samplePhotos,
    smoke: normalizeSourcepadSmoke(configResult, photosResult),
    watch: normalizeSourcepadWatch(watchResult),
    rescan: normalizeSourcepadRescanAvailability(watchResult)
  };
}

function normalizeIndex(indexResult) {
  if (indexResult.status === "rejected") {
    return {
      sourcePath: "",
      indexDir: "",
      summary: EMPTY_INDEX_SUMMARY,
      message: "No se pudo leer el estado del indice."
    };
  }

  const result = indexResult.value || {};
  const summary = result.summary || EMPTY_INDEX_SUMMARY;
  const totalPhotos = getNumber(summary.totalPhotos);
  const trackedPhotos = getNumber(summary.trackedPhotos);
  const indexedPhotos = getNumber(summary.indexedPhotos);
  const pendingPhotos = getNumber(summary.pendingPhotos);

  return {
    sourcePath: result.sourcePath || "",
    indexDir: result.indexDir || "",
    summary,
    message: totalPhotos > 0
      ? `${indexedPhotos} indexadas, ${pendingPhotos} pendientes, ${trackedPhotos}/${totalPhotos} con estado de indice.`
      : "Indice sin fotos detectadas para el sourcepad actual."
  };
}

function normalizePreview(previewResult) {
  if (previewResult.status === "rejected") {
    return {
      photos: [],
      updatedAt: null,
      message: "No se pudo leer la ultima preview."
    };
  }

  const result = previewResult.value || {};
  const photos = Array.isArray(result.photos) ? result.photos : [];
  const updatedAt = Number(result.updatedAt);

  return {
    photos,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    message: photos.length > 0
      ? `${photos.length} fotos cargadas en la preview del reproductor.`
      : "No hay preview cargada para el reproductor."
  };
}

function normalizeIpc(pingResult) {
  if (pingResult.status === "rejected") {
    return {
      ok: false,
      message: "Electron IPC no respondio.",
      detail: String(pingResult.reason?.message || pingResult.reason)
    };
  }

  const result = pingResult.value || {};
  const hasElectronIpc = !result.browserFallback;
  return {
    ok: hasElectronIpc,
    message: hasElectronIpc
      ? "Electron IPC respondio."
      : "Renderer usando fallback; Electron IPC no esta disponible.",
    detail: JSON.stringify(result)
  };
}

async function loadDiagnostics(desktopApi) {
  const [pingResult, configResult, photosResult, indexResult, previewResult, watchResult] = await Promise.all([
    settle(() => desktopApi.ping()),
    settle(() => desktopApi.invoke("config:get-source-path")),
    settle(() =>
      desktopApi.invoke("config:list-source-photos", {
        offset: 0,
        limit: SOURCE_PHOTO_SAMPLE_LIMIT
      })
    ),
    settle(() => desktopApi.invoke("index:get-status")),
    settle(() => desktopApi.invoke("player:get-preview-photos")),
    settleOptionalIpc(desktopApi, SOURCEPAD_WATCH_STATUS_CHANNEL)
  ]);

  const errors = [
    getSettledError("Electron IPC", pingResult),
    getIpcFallbackError(pingResult),
    getSettledError("Sourcepad configurado", configResult),
    getSourcepadConfigurationError(configResult),
    getSettledError("Muestra de fotos sourcepad", photosResult),
    getSettledError("Estado del indice", indexResult),
    getSettledError("Preview del reproductor", previewResult),
    getOptionalSettledError("Watch sourcepad", watchResult)
  ].filter(Boolean);

  return {
    loading: false,
    checkedAt: Date.now(),
    ipc: normalizeIpc(pingResult),
    sourcepad: normalizeSourcepad(configResult, photosResult, watchResult),
    index: normalizeIndex(indexResult),
    preview: normalizePreview(previewResult),
    rescanning: false,
    errors
  };
}

export default function useDiagnostics({ desktopApi, activeView }) {
  const [diagnostics, setDiagnostics] = useState(INITIAL_DIAGNOSTICS);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setDiagnostics((current) => ({
      ...current,
      loading: true,
      errors: []
    }));

    const nextDiagnostics = await loadDiagnostics(desktopApi);

    if (requestIdRef.current !== requestId) {
      return;
    }

    setDiagnostics(nextDiagnostics);
  }, [desktopApi]);

  const rescanSourcepad = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setDiagnostics((current) => ({
      ...current,
      loading: true,
      rescanning: true,
      errors: []
    }));

    const rescanResult = await settleOptionalIpc(desktopApi, SOURCEPAD_RESCAN_CHANNEL);
    const nextDiagnostics = await loadDiagnostics(desktopApi);

    if (requestIdRef.current !== requestId) {
      return;
    }

    const rescanError = getOptionalSettledError("Rescan sourcepad", rescanResult);
    const errors = rescanError ? [rescanError, ...nextDiagnostics.errors] : nextDiagnostics.errors;

    setDiagnostics({
      ...nextDiagnostics,
      sourcepad: {
        ...nextDiagnostics.sourcepad,
        rescan: normalizeSourcepadRescanResult(rescanResult)
      },
      rescanning: false,
      errors
    });
  }, [desktopApi]);

  useEffect(() => {
    if (activeView !== "diagnostics") {
      return;
    }

    refresh();
  }, [activeView, refresh]);

  return {
    ...diagnostics,
    sourcePhotoSampleLimit: SOURCE_PHOTO_SAMPLE_LIMIT,
    refresh,
    rescanSourcepad
  };
}
