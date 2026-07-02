import { useCallback, useEffect, useMemo, useState } from "react";

export default function useSourcePathConfig(desktopApi) {
  const [sourcePath, setSourcePath] = useState("");
  const [persistedPath, setPersistedPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "idle", message: "" });

  useEffect(() => {
    let active = true;

    const loadConfiguration = async () => {
      try {
        const result = await desktopApi.invoke("config:get-source-path");
        if (!active) {
          return;
        }
        const value = result?.value || result?.rawValue || "";
        setSourcePath(value);
        setPersistedPath(value);
        if (!result?.value && result?.rawValue) {
          setStatus({
            type: "error",
            message: "La carpeta sourcepad guardada ya no existe. Selecciona una carpeta valida."
          });
        }
      } catch (error) {
        if (active) {
          setStatus({
            type: "error",
            message: `No se pudo cargar la ruta del sourcepad: ${String(error.message || error)}`
          });
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    loadConfiguration();
    return () => {
      active = false;
    };
  }, [desktopApi]);

  const hasChanges = sourcePath.trim() !== persistedPath.trim();
  const canSave = Boolean(sourcePath.trim()) && hasChanges && !saving && !loading;

  const statusClassName = useMemo(() => {
    if (status.type === "success") {
      return "status status-success";
    }
    if (status.type === "error") {
      return "status status-error";
    }
    return "status";
  }, [status.type]);

  const handlePickFolder = useCallback(async () => {
    setPicking(true);
    setStatus({ type: "idle", message: "" });

    try {
      const result = await desktopApi.invoke("config:pick-source-path");
      if (result?.canceled) {
        return;
      }
      const selectedPath = result?.value || "";
      if (selectedPath) {
        setSourcePath(selectedPath);
      }
    } catch (error) {
      setStatus({
        type: "error",
        message: `No se pudo abrir el selector de carpeta: ${String(error.message || error)}`
      });
    } finally {
      setPicking(false);
    }
  }, [desktopApi]);

  const handleSave = useCallback(async () => {
    if (!sourcePath.trim()) {
      setStatus({ type: "error", message: "Primero selecciona una carpeta sourcepad valida." });
      return;
    }

    setSaving(true);
    setStatus({ type: "idle", message: "" });

    try {
      const result = await desktopApi.invoke("config:set-source-path", {
        value: sourcePath
      });
      const value = result?.value || sourcePath;
      setPersistedPath(value);
      setSourcePath(value);
      setStatus({ type: "success", message: "Carpeta sourcepad guardada en la base de datos." });
    } catch (error) {
      setStatus({
        type: "error",
        message: `No se pudo guardar la ruta del sourcepad: ${String(error.message || error)}`
      });
    } finally {
      setSaving(false);
    }
  }, [desktopApi, sourcePath]);

  return {
    sourcePath,
    persistedPath,
    loading,
    picking,
    saving,
    status,
    statusClassName,
    hasChanges,
    canSave,
    setSourcePath,
    handlePickFolder,
    handleSave
  };
}
