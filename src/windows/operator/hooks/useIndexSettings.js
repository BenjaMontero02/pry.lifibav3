import { useCallback, useEffect, useState } from "react";

const DEFAULT_FACE_SIZE_PX = 28;
const DEFAULT_FACE_DET_SCORE = 0.50;
const DEFAULT_MIN_FACE_QUALITY = 0;
const DEFAULT_DETECTION_MODE = "standard";

export default function useIndexSettings(desktopApi, activeView) {
  const [faceSizePx, setFaceSizePx] = useState(DEFAULT_FACE_SIZE_PX);
  const [faceDetScore, setFaceDetScore] = useState(DEFAULT_FACE_DET_SCORE);
  const [minFaceQuality, setMinFaceQuality] = useState(DEFAULT_MIN_FACE_QUALITY);
  // "precise" suma una pasada del detector a 3072 px: mas caras chicas, analisis mas lento.
  const [detectionMode, setDetectionMode] = useState(DEFAULT_DETECTION_MODE);
  // Cobertura de calidad del indice: {faces, withQuality, qualityBackend} o null.
  const [indexQuality, setIndexQuality] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "idle", message: "" });

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      try {
        const result = await desktopApi.invoke("config:get-index-settings");
        if (!active) return;
        setFaceSizePx(result?.faceSizePx ?? DEFAULT_FACE_SIZE_PX);
        setFaceDetScore(result?.faceDetScore ?? DEFAULT_FACE_DET_SCORE);
        setMinFaceQuality(result?.minFaceQuality ?? DEFAULT_MIN_FACE_QUALITY);
        setDetectionMode(result?.detectionMode ?? DEFAULT_DETECTION_MODE);
        setIndexQuality(result?.indexQuality ?? null);
      } catch {
        if (active) {
          setStatus({ type: "error", message: "No se pudieron cargar los ajustes de indexado." });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadSettings();
    return () => { active = false; };
  }, [desktopApi]);

  // Un reindexado pudo cambiar la cobertura de calidad: se vuelve a leer al entrar
  // a Ajustes. Solo toca indexQuality, no los valores que el operador esta editando.
  useEffect(() => {
    if (activeView !== "settings") return undefined;
    let active = true;
    desktopApi
      .invoke("config:get-index-settings")
      .then((result) => {
        if (active) setIndexQuality(result?.indexQuality ?? null);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [desktopApi, activeView]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus({ type: "idle", message: "" });

    try {
      await desktopApi.invoke("config:set-index-settings", {
        faceSizePx,
        faceDetScore,
        minFaceQuality,
        detectionMode
      });
      setStatus({
        type: "success",
        message:
          "Ajustes guardados. La deteccion se aplica en el proximo 'Actualizar fotos', que va a reanalizar todo el catalogo. La calidad minima se aplica en la proxima busqueda."
      });
    } catch (error) {
      setStatus({
        type: "error",
        message: `No se pudieron guardar los ajustes: ${String(error.message || error)}`
      });
    } finally {
      setSaving(false);
    }
  }, [desktopApi, faceSizePx, faceDetScore, minFaceQuality, detectionMode]);

  return {
    faceSizePx,
    faceDetScore,
    minFaceQuality,
    detectionMode,
    indexQuality,
    loading,
    saving,
    status,
    setFaceSizePx,
    setFaceDetScore,
    setMinFaceQuality,
    setDetectionMode,
    handleSave
  };
}
