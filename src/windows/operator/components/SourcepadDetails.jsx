import { formatCount, formatDateTime } from "../../../shared/formatters";

function getWatcherStatusMeta(watchStatus) {
  if (!watchStatus?.sourcePath) {
    return { label: "Sin carpeta", tone: "muted" };
  }
  if (watchStatus.lastError) {
    return { label: "Error", tone: "error" };
  }
  if (watchStatus.pendingRescan) {
    return { label: "Revisando", tone: "busy" };
  }
  if (watchStatus.dirty) {
    return { label: "Cambios pendientes", tone: "busy" };
  }
  if (watchStatus.watching) {
    return { label: "Activo", tone: "ok" };
  }
  return { label: "Inactivo", tone: "muted" };
}

function getPrewarmStatusMeta(prewarm) {
  const pending = Number(prewarm?.pending || 0);
  const failed = Number(prewarm?.failed || 0);
  const total = Number(prewarm?.total || 0);
  if (failed > 0) {
    return { label: "Con fallas", tone: "error" };
  }
  if (pending > 0) {
    return { label: "Procesando", tone: "busy" };
  }
  if (total > 0) {
    return { label: "Listo", tone: "ok" };
  }
  return { label: "Sin actividad", tone: "muted" };
}

function getChangeText(watchStatus) {
  const lastEvent = watchStatus?.lastEvent || {};
  const eventType = lastEvent.eventType || "cambio";
  const filename = lastEvent.filename ? ` - ${lastEvent.filename}` : "";
  const timestamp = watchStatus?.lastChangedAt || lastEvent.noticedAt;
  if (!timestamp && !lastEvent.filename) {
    return "Sin cambios detectados";
  }
  return `Ultimo cambio: ${eventType}${filename} (${formatDateTime(timestamp)})`;
}

export default function SourcepadDetails({ watchStatus, thumbnailPrewarm }) {
  const currentWatchStatus = watchStatus || {};
  const prewarm = thumbnailPrewarm || currentWatchStatus.thumbnailPrewarm || {};
  const watcherStatus = getWatcherStatusMeta(currentWatchStatus);
  const prewarmStatus = getPrewarmStatusMeta(prewarm);
  const lastError = currentWatchStatus.lastError ||
    (Number(prewarm.failed || 0) > 0 ? "Algunas miniaturas no se pudieron generar." : "");
  const completed = Number(prewarm.completed || 0);
  const failed = Number(prewarm.failed || 0);
  const pending = Number(prewarm.pending || 0);

  return (
    <details className="sourcepad-details">
      <summary className="sourcepad-details-summary">
        <span className="sourcepad-details-title">Carpeta y miniaturas</span>
        <span className={`sourcepad-chip sourcepad-chip-${watcherStatus.tone}`}>
          Carpeta: {watcherStatus.label}
        </span>
        <span className={`sourcepad-chip sourcepad-chip-${prewarmStatus.tone}`}>
          Miniaturas: {prewarmStatus.label}
        </span>
      </summary>

      <div className="sourcepad-runtime">
        <div className="sourcepad-runtime-grid">
          <div className="sourcepad-runtime-panel">
            <p className="sourcepad-runtime-line" title={getChangeText(currentWatchStatus)}>
              {getChangeText(currentWatchStatus)}
            </p>
            <p className="meta">Ultima revision: {formatDateTime(currentWatchStatus.lastScannedAt)}</p>
          </div>

          <div className="sourcepad-runtime-panel">
            <div className="sourcepad-thumbnail-stats" aria-label="Progreso de miniaturas">
              <span>
                <strong>{formatCount(pending)}</strong>
                <small>Pendientes</small>
              </span>
              <span>
                <strong>{formatCount(completed)}</strong>
                <small>Listas</small>
              </span>
              <span>
                <strong>{formatCount(failed)}</strong>
                <small>Fallidas</small>
              </span>
            </div>
          </div>
        </div>

        <p className={`sourcepad-runtime-error${lastError ? " sourcepad-runtime-error-active" : ""}`}>
          Ultimo error: <span>{lastError || "sin errores"}</span>
        </p>
      </div>
    </details>
  );
}
