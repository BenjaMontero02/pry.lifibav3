import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_SIMILARITY_THRESHOLD = 0.45;
const SCAN_CAPTURE_MAX_DIMENSION = 720;
const SCAN_CAPTURE_JPEG_QUALITY = 0.82;
const SCAN_CAMERA_START_TIMEOUT_MS = 8_000;
const SCAN_CAPTURE_FRAME_COUNT = 4;
const SCAN_CAPTURE_FRAME_INTERVAL_MS = 250;

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

function buildSourcePhotoUrl(filePath) {
  return `sourcephoto://${encodeURIComponent(filePath)}`;
}

function captureVideoFrame(videoElement, canvasElement) {
  const sourceWidth = videoElement.videoWidth || 1280;
  const sourceHeight = videoElement.videoHeight || 720;
  const scale = Math.min(1, SCAN_CAPTURE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
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
  const [scanThreshold, setScanThreshold] = useState(DEFAULT_SIMILARITY_THRESHOLD);
  const [scanVideoReady, setScanVideoReady] = useState(false);
  const [scanCameraActive, setScanCameraActive] = useState(false);
  const [scanCameraStarting, setScanCameraStarting] = useState(false);
  const [scanCameraEnabled, setScanCameraEnabled] = useState(true);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [availableCameras, setAvailableCameras] = useState([]);
  const [jumpToMatchValue, setJumpToMatchValue] = useState("");
  const [jumpToMatchFeedback, setJumpToMatchFeedback] = useState({ type: "idle", message: "" });

  const scanVideoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const scanStreamRef = useRef(null);
  const scanCaptureAbortRef = useRef(null);
  const matchCardRefs = useRef(new Map());

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
    setScanCameraStarting(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Este entorno no expone acceso a camara.");
      }

      await refreshWebcams();
      const constraints = {
        video: selectedCameraId
          ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      };
      const stream = await getUserMediaWithTimeout(constraints);
      videoElement.srcObject = stream;
      scanStreamRef.current = stream;
      setScanCameraActive(true);
      setScanStatus({ type: "idle", message: "" });
    } catch (error) {
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

    try {
      const frames = [];
      for (let frameIndex = 0; frameIndex < SCAN_CAPTURE_FRAME_COUNT; frameIndex += 1) {
        if (abortController.signal.aborted) {
          return;
        }
        frames.push(captureVideoFrame(videoElement, canvasElement));
        if (frameIndex < SCAN_CAPTURE_FRAME_COUNT - 1) {
          await delay(SCAN_CAPTURE_FRAME_INTERVAL_MS);
        }
      }
      if (abortController.signal.aborted) {
        return;
      }

      const safeThreshold = Number.isFinite(scanThreshold) ? scanThreshold : DEFAULT_SIMILARITY_THRESHOLD;

      const response = await desktopApi.sendToPython("find_player", {
        frames,
        similarityThreshold: safeThreshold,
        maxResults: 12
      });
      if (abortController.signal.aborted) {
        return;
      }

      const result = response?.result || {};
      const matches = (result.matches || []).map((match, index) => ({
        ...match,
        url: buildSourcePhotoUrl(match.photoPath),
        key: `${match.photoPath}-${match.faceOrdinal}`,
        displayNumber: index + 1
      }));
      setScanMatches(matches);
      setSelectedMatchKeys([]);

      if (result.status === "no_face_detected") {
        setScanStatus({ type: "error", message: "No se detecto una cara en los frames capturados." });
        return;
      }
      if (result.status === "no_matches_above_threshold") {
        setScanStatus({
          type: "error",
          message: `No hubo matches por encima del umbral (${(result.threshold ?? safeThreshold).toFixed(2)}).`
        });
        return;
      }
      if (result.status === "empty_index") {
        setScanStatus({
          type: "error",
          message: "El indice de rostros esta vacio. Primero ejecuta 'Actualizar fotos'."
        });
        return;
      }

      setScanStatus({
        type: "success",
        message: `Se encontraron ${matches.length} coincidencias ordenadas por similitud.`
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
      if (scanCaptureAbortRef.current === abortController) {
        scanCaptureAbortRef.current = null;
      }
      setScanInProgress(false);
    }
  }, [desktopApi, scanCameraActive, scanThreshold, scanVideoReady]);

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
        message: `Previsualizacion enviada al reproductor (${result?.count || selectedMatches.length} fotos).`
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

  const handleToggleScanCamera = useCallback(() => {
    setScanCameraEnabled((current) => !current);
  }, []);

  const handleScanVideoLoadedMetadata = useCallback(() => {
    setScanVideoReady(true);
    setScanCameraStarting(false);
  }, []);

  const clearMatches = useCallback(() => {
    setScanMatches([]);
    setSelectedMatchKeys([]);
  }, []);

  return {
    availableCameras,
    selectedCameraId,
    scanThreshold,
    scanCameraStarting,
    scanCameraActive,
    scanVideoReady,
    scanInProgress,
    scanMatches,
    selectedMatchKeys,
    selectedMatches,
    sendingPreview,
    scanStatus,
    jumpToMatchValue,
    jumpToMatchFeedback,
    scanVideoRef,
    scanCanvasRef,
    matchCardRefs,
    setSelectedCameraId,
    setScanThreshold,
    setJumpToMatchValue,
    handleToggleScanCamera,
    handleCaptureAndSearch,
    handleScanVideoLoadedMetadata,
    handleJumpToMatch,
    handleSendPreview,
    toggleMatchSelection,
    clearMatches
  };
}
