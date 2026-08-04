import { useCallback, useEffect, useState } from "react";

const DEFAULT_FACE_SIZE_PX = 28;
const DEFAULT_FACE_DET_SCORE = 0.50;

export default function useIndexSettings(desktopApi) {
  const [faceSizePx, setFaceSizePx] = useState(DEFAULT_FACE_SIZE_PX);
  const [faceDetScore, setFaceDetScore] = useState(DEFAULT_FACE_DET_SCORE);
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

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus({ type: "idle", message: "" });

    try {
      await desktopApi.invoke("config:set-index-settings", { faceSizePx, faceDetScore });
      setStatus({ type: "success", message: "Ajustes de indexado guardados." });
    } catch (error) {
      setStatus({
        type: "error",
        message: `No se pudieron guardar los ajustes: ${String(error.message || error)}`
      });
    } finally {
      setSaving(false);
    }
  }, [desktopApi, faceSizePx, faceDetScore]);

  return {
    faceSizePx,
    faceDetScore,
    loading,
    saving,
    status,
    setFaceSizePx,
    setFaceDetScore,
    handleSave
  };
}
