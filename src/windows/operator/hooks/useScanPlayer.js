import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSourcePhotoUrl, buildSourceThumbUrl } from "../../../shared/sourceUrls";

// Mismo default que python/app/actions/find_player.py. Sin calibrar con fotos
// reales del evento: el operador lo ajusta desde la pantalla Escanear.
const DEFAULT_SIMILARITY_THRESHOLD = 0.45;
const MIN_SIMILARITY_THRESHOLD = 0.2;
const MAX_SIMILARITY_THRESHOLD = 0.8;
// Tope de resultados por escaneo. Antes eran 12: un jugador con mas fotos veia
// un corte distinto en cada escaneo y sin aviso de que habia mas.
const SCAN_MAX_RESULTS = 200;
const SCAN_SETTINGS_STORAGE_KEY = "lifiba.scanSettings.v1";
// Se captura a la resolucion pedida a la camara (1280x720): achicar a 720 px
// dejaba la cara de un jugador alejado del celular cerca del minimo de 32 px.
const SCAN_CAPTURE_MAX_DIMENSION = 1280;
// Indicador en vivo: frame chico cada ~500 ms al detector (sin embeddings).
const FACE_PREVIEW_MAX_DIMENSION = 480;
const FACE_PREVIEW_INTERVAL_MS = 500;
const FACE_PREVIEW_ERROR_BACKOFF_MS = 3000;
// Margen sobre el minimo de la busqueda para decir "buen tamano".
const FACE_PREVIEW_SIZE_MARGIN = 1.5;
const SCAN_CAPTURE_JPEG_QUALITY = 0.82;
const SCAN_CAMERA_START_TIMEOUT_MS = 8_000;
// Frames repartidos en ~1.2 s: con 4 frames en 750 ms eran casi identicos y
// promediarlos no reducia la variacion entre un escaneo y el siguiente.
const SCAN_CAPTURE_FRAME_COUNT = 7;
const SCAN_CAPTURE_FRAME_INTERVAL_MS = 200;
// Escaneo en 3 angulos (opcional): una rafaga por angulo con una pausa antes para
// que el jugador gire. 4 frames x 3 = 12, bajo el tope de 16 de Python. Se pide
// girar "un poco": de perfil completo los landmarks del detector fallan.
const ANGLE_CAPTURE_FRAME_COUNT = 4;
const ANGLE_CAPTURE_STEPS = [
  { angle: "front", prompt: "Mirá a la cámara", leadMs: 900 },
  { angle: "left", prompt: "Girá un poco la cabeza hacia tu izquierda", leadMs: 1600 },
  { angle: "right", prompt: "Ahora girá un poco hacia tu derecha", leadMs: 1600 }
];
const ANGLE_SEARCH_PROMPT = "¡Listo! Buscando tus fotos…";
const ANGLE_LABELS = { front: "de frente", left: "izquierda", right: "derecha" };

function clampThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SIMILARITY_THRESHOLD;
  }
  return Math.min(MAX_SIMILARITY_THRESHOLD, Math.max(MIN_SIMILARITY_THRESHOLD, numeric));
}

function loadScanSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCAN_SETTINGS_STORAGE_KEY) || "null");
    return {
      threshold: clampThreshold(parsed?.threshold ?? DEFAULT_SIMILARITY_THRESHOLD),
      queryExpansion: parsed?.queryExpansion === true,
      multiAngle: parsed?.multiAngle === true
    };
  } catch {
    return { threshold: DEFAULT_SIMILARITY_THRESHOLD, queryExpansion: false, multiAngle: false };
  }
}

function saveScanSettings(settings) {
  try {
    window.localStorage.setItem(SCAN_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Sin storage disponible el ajuste dura solo esta sesion.
  }
}

// Texto extra del estado del escaneo sobre el filtro de calidad: cuantas caras se
// ocultaron y, si el indice no tiene calidad en todas sus caras, que hay que reindexar.
function describeQualityFilter(search) {
  const hidden = Number(search?.facesFilteredByQuality || 0);
  const minQuality = Number(search?.minFaceQuality || 0);
  const indexSize = Number(search?.indexSize || 0);
  const withQuality = Number(search?.facesWithQuality || 0);
  if (minQuality <= 0) {
    return "";
  }
  if (search?.qualityAvailable === false) {
    return " El filtro de calidad necesita el modelo AdaFace; con el modelo de respaldo no oculta nada.";
  }
  const hiddenText = hidden > 0 ? ` Se ocultaron ${hidden} caras de baja calidad.` : "";
  const reindexText =
    withQuality < indexSize
      ? " El indice no tiene calidad guardada en todas las caras: usa 'Reindexar todo' en Fotos para que el filtro aplique."
      : "";
  return `${hiddenText}${reindexText}`;
}

// Resumen del escaneo en 3 angulos para el operador: angulos descartados, sin
// cara o casi sin giro, y cuantas fotos entraron solo por un angulo girado.
function describeAngles(angles, matches) {
  if (!Array.isArray(angles)) {
    return "";
  }
  const notes = [];
  angles.forEach((entry) => {
    const label = ANGLE_LABELS[entry.angle] || entry.angle;
    if (entry.status === "rejected_identity") {
      notes.push(`se descarto el angulo ${label} (no parecia la misma persona)`);
    } else if (entry.status === "no_face") {
      notes.push(`no se vio la cara en el angulo ${label}`);
    } else if (entry.turnedEnough === false) {
      notes.push(`en el angulo ${label} casi no giro la cabeza`);
    }
  });
  const sideOnly = (matches || []).filter((match) => match.viaSideAngle).length;
  const sideText =
    sideOnly > 0
      ? ` ${sideOnly} ${sideOnly === 1 ? "foto aparecio" : "fotos aparecieron"} solo por los angulos girados (marcadas "angulo"): revisalas.`
      : "";
  const notesText = notes.length > 0 ? ` Angulos: ${notes.join("; ")}.` : "";
  return `${notesText}${sideText}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getCameraErrorMessage(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permiso de camara denegado. Habilitalo para esta app en el navegador/sistema.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se encontro ninguna camara disponible.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "La camara esta en uso por otra aplicacion. Cerrala e intenta de nuevo.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "No se pudo abrir la camara elegida con esos parametros. Proba otra camara.";
  }
  if (name === "TimeoutError") {
    return "La camara no respondio a tiempo. Revisa permisos o selecciona otra camara.";
  }
  return `No se pudo iniciar la webcam: ${String(error?.message || error)}`;
}

function captureVideoFrame(videoElement, canvasElement, maxDimension = SCAN_CAPTURE_MAX_DIMENSION) {
  const sourceWidth = videoElement.videoWidth || 1280;
  const sourceHeight = videoElement.videoHeight || 720;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  canvasElement.width = width;
  canvasElement.height = height;

  const context = canvasElement.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("No se pudo preparar el canvas de captura.");
  }

  context.drawImage(videoElement, 0, 0, width, height);
  return canvasElement.toDataURL("image/jpeg", SCAN_CAPTURE_JPEG_QUALITY);
}

// Estado del indicador a partir de la respuesta de preview_face. El tamano viene
// en pixeles del frame chico: se escala a la resolucion con la que se captura.
function describeFacePreview(result, videoElement) {
  if (!result || result.busy) {
    return { state: "paused", message: "Indicador en pausa mientras se analizan fotos." };
  }
  if (!result.primary) {
    return { state: "none", message: "No se ve ninguna cara." };
  }
  const longest = Math.max(videoElement?.videoWidth || 1280, videoElement?.videoHeight || 720);
  const captureScale = Math.min(1, SCAN_CAPTURE_MAX_DIMENSION / longest);
  const previewScale = Math.min(1, FACE_PREVIEW_MAX_DIMENSION / longest);
  const sizeAtCapture = (Number(result.primary.sizePx) * captureScale) / previewScale;
  const crowdText = result.faceCount > 1 ? ` Hay ${result.faceCount} caras: se usa la mas grande.` : "";
  if (sizeAtCapture < Number(result.minFaceSizePx || 32) * FACE_PREVIEW_SIZE_MARGIN) {
    return { state: "small", message: `Cara muy chica: que el jugador se acerque a la camara.${crowdText}` };
  }
  return { state: "ok", message: `Cara detectada.${crowdText}` };
}

function getUserMediaWithTimeout(constraints) {
  const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
  let timeoutId = 0;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error("Camera start timed out.");
      error.name = "TimeoutError";
      reject(error);
    }, SCAN_CAMERA_START_TIMEOUT_MS);
  });

  return Promise.race([streamPromise, timeoutPromise])
    .then((stream) => {
      window.clearTimeout(timeoutId);
      return stream;
    })
    .catch((error) => {
      window.clearTimeout(timeoutId);
      streamPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
        })
        .catch(() => {});
      throw error;
    });
}

export default function useScanPlayer({ desktopApi, activeView }) {
  const [scanStatus, setScanStatus] = useState({ type: "idle", message: "" });
  const [scanInProgress, setScanInProgress] = useState(false);
  const [scanMatches, setScanMatches] = useState([]);
  const [selectedMatchKeys, setSelectedMatchKeys] = useState([]);
  const [sendingPreview, setSendingPreview] = useState(false);
  const [printingPhotos, setPrintingPhotos] = useState(false);
  const [scanSettings, setScanSettings] = useState(loadScanSettings);
  const scanThreshold = scanSettings.threshold;
  const scanQueryExpansion = scanSettings.queryExpansion;
  const scanMultiAngle = scanSettings.multiAngle;
  // Indicacion visible durante la captura guiada (operador y pantalla del jugador).
  const [scanPrompt, setScanPrompt] = useState(null);
  // Indicador en vivo de la camara: {state: ok|small|none|paused, message} o null.
  const [facePreview, setFacePreview] = useState(null);
  const facePreviewCanvasRef = useRef(null);
  const [scanVideoReady, setScanVideoReady] = useState(false);
  const [scanCameraActive, setScanCameraActive] = useState(false);
  const [scanCameraStarting, setScanCameraStarting] = useState(false);
  const [scanCameraEnabled, setScanCameraEnabled] = useState(true);
  const [clearingPlayer, setClearingPlayer] = useState(false);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [availableCameras, setAvailableCameras] = useState([]);
  const [jumpToMatchValue, setJumpToMatchValue] = useState("");
  const [jumpToMatchFeedback, setJumpToMatchFeedback] = useState({ type: "idle", message: "" });

  const scanVideoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const scanStreamRef = useRef(null);
  const scanCaptureAbortRef = useRef(null);
  // Cada arranque/parada de camara incrementa este id. Un getUserMedia que
  // resuelve con un id viejo (cambio de camara o de vista mientras arrancaba)
  // detiene sus tracks y no toca el video.
  const scanCameraAttemptRef = useRef(0);
  const matchCardRefs = useRef(new Map());

  const updateScanSettings = useCallback((patch) => {
    setScanSettings((current) => {
      const next = { ...current, ...patch, threshold: clampThreshold(patch.threshold ?? current.threshold) };
      saveScanSettings(next);
      return next;
    });
  }, []);

  const setScanThreshold = useCallback(
    (value) => updateScanSettings({ threshold: value }),
    [updateScanSettings]
  );

  const setScanQueryExpansion = useCallback(
    (enabled) => updateScanSettings({ queryExpansion: Boolean(enabled) }),
    [updateScanSettings]
  );

  const setScanMultiAngle = useCallback(
    (enabled) => updateScanSettings({ multiAngle: Boolean(enabled) }),
    [updateScanSettings]
  );

  // Muestra (o borra con null) la indicacion en el video del operador y en la
  // pantalla publica. Un fallo del IPC no corta el escaneo.
  const showScanPrompt = useCallback(
    (text) => {
      setScanPrompt(text);
      desktopApi.invoke("player:set-scan-prompt", { text }).catch(() => {});
    },
    [desktopApi]
  );

  const refreshWebcams = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    setAvailableCameras(cameras);
    if (!selectedCameraId && cameras.length > 0) {
      setSelectedCameraId(cameras[0].deviceId || "");
    }
  }, [selectedCameraId]);

  const stopScanCamera = useCallback(() => {
    scanCameraAttemptRef.current += 1;
    if (scanCaptureAbortRef.current) {
      scanCaptureAbortRef.current.abort();
      scanCaptureAbortRef.current = null;
    }
    const videoElement = scanVideoRef.current;
    if (videoElement?.srcObject) {
      videoElement.srcObject.getTracks().forEach((track) => track.stop());
      videoElement.srcObject = null;
    }
    if (scanStreamRef.current) {
      scanStreamRef.current.getTracks().forEach((track) => track.stop());
      scanStreamRef.current = null;
    }
    setScanCameraStarting(false);
    setScanVideoReady(false);
    setScanCameraActive(false);
  }, []);

  const startScanCamera = useCallback(async () => {
    const videoElement = scanVideoRef.current;
    if (!videoElement) {
      return;
    }

    stopScanCamera();
    const attemptId = scanCameraAttemptRef.current;
    const isStaleAttempt = () => attemptId !== scanCameraAttemptRef.current;
    setScanCameraStarting(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Este entorno no expone acceso a camara.");
      }

      await refreshWebcams();
      if (isStaleAttempt()) {
        return;
      }
      const constraints = {
        video: selectedCameraId
          ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      };
      const stream = await getUserMediaWithTimeout(constraints);
      if (isStaleAttempt()) {
        // Llego tarde: la camara ya no se usa, no dejar el stream abierto.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      videoElement.srcObject = stream;
      scanStreamRef.current = stream;
      setScanCameraActive(true);
      setScanStatus({ type: "idle", message: "" });
    } catch (error) {
      if (isStaleAttempt()) {
        return;
      }
      setScanCameraStarting(false);
      setScanCameraActive(false);
      setScanStatus({ type: "error", message: getCameraErrorMessage(error) });
    }
  }, [refreshWebcams, selectedCameraId, stopScanCamera]);

  useEffect(() => {
    if (activeView !== "scan-player") {
      stopScanCamera();
      return;
    }

    if (!scanCameraEnabled) {
      stopScanCamera();
      return;
    }

    startScanCamera();

    return () => {
      stopScanCamera();
    };
  }, [activeView, scanCameraEnabled, selectedCameraId, startScanCamera, stopScanCamera]);

  const handleCaptureAndSearch = useCallback(async () => {
    const videoElement = scanVideoRef.current;
    const canvasElement = scanCanvasRef.current;
    if (!videoElement || !canvasElement) {
      setScanStatus({ type: "error", message: "No se encontro el componente de webcam en pantalla." });
      return;
    }
    if (!scanCameraActive) {
      setScanStatus({ type: "error", message: "La webcam esta apagada. Prendela para escanear." });
      return;
    }
    if (!scanVideoReady) {
      setScanStatus({ type: "error", message: "La webcam todavia no esta lista." });
      return;
    }

    if (scanCaptureAbortRef.current) {
      scanCaptureAbortRef.current.abort();
    }
    const abortController = new AbortController();
    scanCaptureAbortRef.current = abortController;

    setScanInProgress(true);
    setScanStatus({ type: "idle", message: "" });

    // Rafaga de frames; null si el escaneo se aborto en el medio.
    const captureBurst = async (count) => {
      const frames = [];
      for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        if (abortController.signal.aborted) {
          return null;
        }
        frames.push(captureVideoFrame(videoElement, canvasElement));
        if (frameIndex < count - 1) {
          await delay(SCAN_CAPTURE_FRAME_INTERVAL_MS);
        }
      }
      return abortController.signal.aborted ? null : frames;
    };

    try {
      let framesPayload;
      if (scanMultiAngle) {
        const frameGroups = [];
        for (const step of ANGLE_CAPTURE_STEPS) {
          showScanPrompt(step.prompt);
          await delay(step.leadMs);
          const frames = await captureBurst(ANGLE_CAPTURE_FRAME_COUNT);
          if (!frames) {
            return;
          }
          frameGroups.push({ angle: step.angle, frames });
        }
        showScanPrompt(ANGLE_SEARCH_PROMPT);
        framesPayload = { frameGroups };
      } else {
        const frames = await captureBurst(SCAN_CAPTURE_FRAME_COUNT);
        if (!frames) {
          return;
        }
        framesPayload = { frames };
      }

      const response = await desktopApi.sendToPython("find_player", {
        ...framesPayload,
        similarityThreshold: clampThreshold(scanThreshold),
        maxResults: SCAN_MAX_RESULTS,
        queryExpansion: scanQueryExpansion
      });
      if (abortController.signal.aborted) {
        return;
      }

      const result = response?.result || {};
      const matches = (result.matches || []).map((match, index) => ({
        ...match,
        url: buildSourcePhotoUrl(match.photoPath),
        thumbUrl: buildSourceThumbUrl(match.photoPath),
        key: `${match.photoPath}-${match.faceOrdinal}`,
        displayNumber: index + 1
      }));
      setScanMatches(matches);
      setSelectedMatchKeys([]);

      if (result.status === "no_face_detected") {
        setScanStatus({
          type: "error",
          message: Array.isArray(result.angles)
            ? "No se detecto la cara de frente. Pedile al jugador que mire a la camara y repeti."
            : "No se detecto una cara en los frames capturados."
        });
        return;
      }
      if (result.status === "no_matches_above_threshold") {
        setScanStatus({
          type: "error",
          message: `No se encontraron fotos con suficiente similitud. Proba bajando el umbral de coincidencia.${describeQualityFilter(result.search)}${describeAngles(result.angles, [])}`
        });
        return;
      }
      if (result.status === "index_stale") {
        // Para indice desalineado o ilegible Python ya manda el mensaje en
        // espanol con la accion a seguir; el cambio de modelo viene en ingles.
        setScanStatus({
          type: "error",
          message:
            result.reason !== "embedding_model_mismatch" && result.message
              ? result.message
              : "El indice esta desactualizado (se armo con otro modelo de reconocimiento). Volve a indexar desde Fotos."
        });
        return;
      }
      if (result.status === "empty_index") {
        setScanStatus({
          type: "error",
          message: "Todavia no se analizaron las fotos. Anda a Fotos y presiona 'Actualizar fotos'."
        });
        return;
      }

      const moreText = result.hasMore
        ? ` Se muestran las ${matches.length} mas parecidas; puede haber mas (subi el umbral para afinar).`
        : "";
      const rejectedText =
        result.framesRejected > 0
          ? ` Se descartaron ${result.framesRejected} capturas que no coincidian con el resto.`
          : "";
      setScanStatus({
        type: "success",
        message: `Se encontraron ${matches.length} fotos.${moreText}${rejectedText}${describeQualityFilter(result.search)}${describeAngles(result.angles, matches)}`
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      setScanMatches([]);
      setSelectedMatchKeys([]);
      setScanStatus({
        type: "error",
        message: `No se pudo escanear el jugador: ${String(error.message || error)}`
      });
    } finally {
      // Un escaneo abortado por uno nuevo no apaga el "Buscando..." del nuevo.
      // Si lo aborto stopScanCamera (ref en null) si hay que apagarlo.
      // La indicacion se borra siempre (error, aborto, "Nuevo jugador"): nunca debe
      // quedar "Gira a tu izquierda" en la pantalla publica.
      if (scanCaptureAbortRef.current === abortController) {
        scanCaptureAbortRef.current = null;
        setScanInProgress(false);
        if (scanMultiAngle) {
          showScanPrompt(null);
        }
      } else if (scanCaptureAbortRef.current === null) {
        setScanInProgress(false);
        if (scanMultiAngle) {
          showScanPrompt(null);
        }
      }
    }
  }, [
    desktopApi,
    scanCameraActive,
    scanMultiAngle,
    scanQueryExpansion,
    scanThreshold,
    scanVideoReady,
    showScanPrompt
  ]);

  // Esc durante la captura guiada: cancela sin buscar.
  const handleCancelScan = useCallback(() => {
    if (!scanCaptureAbortRef.current) {
      return;
    }
    scanCaptureAbortRef.current.abort();
    scanCaptureAbortRef.current = null;
    setScanInProgress(false);
    showScanPrompt(null);
    setScanStatus({ type: "idle", message: "Escaneo cancelado." });
  }, [showScanPrompt]);

  const toggleMatchSelection = useCallback((matchKey) => {
    setSelectedMatchKeys((current) =>
      current.includes(matchKey) ? current.filter((key) => key !== matchKey) : [...current, matchKey]
    );
  }, []);

  const selectMatchByKey = useCallback((matchKey) => {
    setSelectedMatchKeys((current) => (current.includes(matchKey) ? current : [...current, matchKey]));
  }, []);

  const handleJumpToMatch = useCallback(() => {
    const parsed = Number.parseInt(jumpToMatchValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setJumpToMatchFeedback({ type: "error", message: "Ingresa un numero valido de coincidencia." });
      return;
    }

    const targetMatch = scanMatches.find((match) => match.displayNumber === parsed);
    if (!targetMatch) {
      setJumpToMatchFeedback({
        type: "error",
        message: `No existe la coincidencia #${parsed} en los resultados actuales.`
      });
      return;
    }

    selectMatchByKey(targetMatch.key);

    const matchElement = matchCardRefs.current.get(targetMatch.key);
    if (matchElement) {
      matchElement.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      matchElement.focus({ preventScroll: true });
    }

    setJumpToMatchFeedback({ type: "success", message: `Coincidencia #${parsed} enfocada y seleccionada.` });
  }, [jumpToMatchValue, scanMatches, selectMatchByKey]);

  useEffect(() => {
    setJumpToMatchFeedback({ type: "idle", message: "" });
  }, [scanMatches]);

  const selectedMatches = useMemo(() => {
    const selected = new Set(selectedMatchKeys);
    return scanMatches.filter((match) => selected.has(match.key));
  }, [scanMatches, selectedMatchKeys]);

  const handleSendPreview = useCallback(async () => {
    if (selectedMatches.length === 0) {
      return;
    }

    setSendingPreview(true);
    try {
      const result = await desktopApi.invoke("player:set-preview-photos", {
        photos: selectedMatches.map((match) => ({
          photoPath: match.photoPath,
          url: match.url,
          similarity: match.similarity,
          displayNumber: match.displayNumber
        }))
      });
      setScanStatus({
        type: "success",
        message: `${result?.count || selectedMatches.length} fotos enviadas a la pantalla del jugador.`
      });
    } catch (error) {
      setScanStatus({
        type: "error",
        message: `No se pudo enviar la previsualizacion: ${String(error.message || error)}`
      });
    } finally {
      setSendingPreview(false);
    }
  }, [desktopApi, selectedMatches]);

  const handlePrintSelected = useCallback(async () => {
    if (selectedMatches.length === 0) {
      return;
    }

    setPrintingPhotos(true);
    setScanStatus({ type: "idle", message: "Confirmá la impresión en el diálogo de Windows." });
    try {
      const result = await desktopApi.invoke("print:send", {
        photos: selectedMatches.map((match) => ({ photoPath: match.photoPath }))
      });

      if (result?.cancelled) {
        setScanStatus({ type: "idle", message: "Impresion cancelada." });
        return;
      }

      const count = Number(result?.count || selectedMatches.length);
      const skipped = Number(result?.skipped || 0);
      const skippedText = skipped > 0 ? ` (${skipped} se omitieron porque no se encontraron)` : "";
      setScanStatus({
        type: "success",
        message: `${count} ${count === 1 ? "foto enviada" : "fotos enviadas"} a la impresora${skippedText}.`
      });
    } catch (error) {
      setScanStatus({
        type: "error",
        message: `No se pudo imprimir: ${String(error.message || error)}`
      });
    } finally {
      setPrintingPhotos(false);
    }
  }, [desktopApi, selectedMatches]);

  const handleSelectAllMatches = useCallback(() => {
    setSelectedMatchKeys(scanMatches.map((match) => match.key));
  }, [scanMatches]);

  const handleClearMatchSelection = useCallback(() => {
    setSelectedMatchKeys([]);
  }, []);

  const handleToggleScanCamera = useCallback(() => {
    setScanCameraEnabled((current) => !current);
  }, []);

  // Indicador en vivo: solo con la vista de escaneo abierta, la camara lista y sin
  // un escaneo en curso (no compite con la captura ni encola pedidos en Python).
  useEffect(() => {
    if (activeView !== "scan-player" || !scanCameraActive || !scanVideoReady || scanInProgress) {
      setFacePreview(null);
      return undefined;
    }
    let cancelled = false;
    let timeoutId = 0;

    const tick = async () => {
      const videoElement = scanVideoRef.current;
      let nextDelay = FACE_PREVIEW_INTERVAL_MS;
      try {
        if (!videoElement) {
          return;
        }
        if (!facePreviewCanvasRef.current) {
          facePreviewCanvasRef.current = document.createElement("canvas");
        }
        const frame = captureVideoFrame(videoElement, facePreviewCanvasRef.current, FACE_PREVIEW_MAX_DIMENSION);
        const response = await desktopApi.sendToPython("preview_face", { frame });
        if (!cancelled) {
          setFacePreview(describeFacePreview(response?.result, videoElement));
        }
      } catch {
        // Un fallo del indicador no molesta al operador: se oculta y se reintenta mas tarde.
        if (!cancelled) {
          setFacePreview(null);
        }
        nextDelay = FACE_PREVIEW_ERROR_BACKOFF_MS;
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(tick, nextDelay);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeView, desktopApi, scanCameraActive, scanInProgress, scanVideoReady]);

  const handleScanVideoLoadedMetadata = useCallback(() => {
    setScanVideoReady(true);
    setScanCameraStarting(false);
  }, []);

  const clearMatches = useCallback(() => {
    setScanMatches([]);
    setSelectedMatchKeys([]);
  }, []);

  // Pantalla del jugador en blanco y todo listo para el siguiente escaneo.
  const handleNewPlayer = useCallback(async () => {
    // Un escaneo en curso era del jugador anterior: se descarta.
    if (scanCaptureAbortRef.current) {
      scanCaptureAbortRef.current.abort();
      scanCaptureAbortRef.current = null;
      setScanInProgress(false);
    }
    showScanPrompt(null);
    clearMatches();
    setJumpToMatchValue("");
    setJumpToMatchFeedback({ type: "idle", message: "" });

    setClearingPlayer(true);
    try {
      await desktopApi.invoke("player:set-preview-photos", { photos: [] });
      setScanStatus({ type: "success", message: "Pantalla del jugador limpia. Listo para el siguiente escaneo." });
    } catch (error) {
      setScanStatus({
        type: "error",
        message: `No se pudo limpiar la pantalla del jugador: ${String(error.message || error)}`
      });
    } finally {
      setClearingPlayer(false);
    }
  }, [clearMatches, desktopApi, showScanPrompt]);

  return {
    availableCameras,
    selectedCameraId,
    scanThreshold,
    scanQueryExpansion,
    scanMultiAngle,
    scanPrompt,
    facePreview,
    scanCameraStarting,
    scanCameraActive,
    scanVideoReady,
    scanInProgress,
    scanMatches,
    selectedMatchKeys,
    selectedMatches,
    sendingPreview,
    printingPhotos,
    clearingPlayer,
    scanStatus,
    jumpToMatchValue,
    jumpToMatchFeedback,
    scanVideoRef,
    scanCanvasRef,
    matchCardRefs,
    setSelectedCameraId,
    setScanThreshold,
    setScanQueryExpansion,
    setScanMultiAngle,
    setJumpToMatchValue,
    handleToggleScanCamera,
    handleCaptureAndSearch,
    handleCancelScan,
    handleScanVideoLoadedMetadata,
    handleJumpToMatch,
    handleSendPreview,
    handlePrintSelected,
    handleNewPlayer,
    handleSelectAllMatches,
    handleClearMatchSelection,
    toggleMatchSelection,
    clearMatches
  };
}
