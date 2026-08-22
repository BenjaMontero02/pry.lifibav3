import { useEffect, useState } from "react";
import copyText from "../../../shared/copyText";

const COPY_FEEDBACK_MS = 1800;

export default function PhotoErrorDetail({ message, label = "Detalle del error" }) {
  const [copyState, setCopyState] = useState("");

  useEffect(() => {
    if (!copyState) {
      return undefined;
    }
    const timer = setTimeout(() => setCopyState(""), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  const handleCopy = async () => {
    const copied = await copyText(message);
    setCopyState(copied ? "ok" : "fail");
  };

  return (
    <div className="photo-error-detail">
      <div className="photo-error-detail-head">
        <span className="photo-error-detail-label">{label}</span>
        <button type="button" className="photo-error-copy-btn" onClick={handleCopy}>
          {copyState === "ok" ? "Copiado" : copyState === "fail" ? "No se pudo copiar" : "Copiar"}
        </button>
      </div>
      <pre className="photo-error-detail-text">{message}</pre>
    </div>
  );
}
