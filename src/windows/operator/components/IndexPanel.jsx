import IndexSummary from "./IndexSummary";
import PhotoErrorDetail from "./PhotoErrorDetail";
import { formatCount } from "../../../shared/formatters";

function getIndexStatusMeta({ hasSource, indexing, clearing, pending, errors, total }) {
  if (!hasSource) {
    return { label: "Sin carpeta", tone: "muted" };
  }
  if (clearing) {
    return { label: "Limpiando", tone: "busy" };
  }
  if (indexing) {
    return { label: "Indexando", tone: "busy" };
  }
  if (total === 0) {
    return { label: "Sin fotos", tone: "muted" };
  }
  if (pending > 0) {
    return { label: "Pendiente", tone: "busy" };
  }
  if (errors > 0) {
    return { label: "Con errores", tone: "error" };
  }
  return { label: "Al dia", tone: "ok" };
}

function getIndexPanelHint({ hasSource, total }) {
  if (!hasSource) {
    return "No hay carpeta configurada. Elegi la carpeta del evento en Ajustes para poder indexar.";
  }
  if (total === 0) {
    return "La carpeta no tiene fotos todavia.";
  }
  return "";
}

export default function IndexPanel({
  photosPath,
  photosLoading,
  indexingPhotos,
  indexingProgressPercent,
  indexingProgressLabel,
  indexingMessage,
  clearingIndex,
  currentIndexSummary,
  errorFilterActive,
  onIndexPhotos,
  onReindexAll,
  onClearIndex,
  onShowErrorPhotos
}) {
  const summary = currentIndexSummary || {};
  const errorSamples = Array.isArray(summary.errorSamples) ? summary.errorSamples : [];
  const hasSource = Boolean(photosPath);
  const pending = Number(summary.pendingPhotos || 0);
  const total = Number(summary.totalPhotos || 0);
  const errors = Number(summary.errorPhotos || 0) + Number(summary.unreadablePhotos || 0);
  const busy = photosLoading || indexingPhotos || clearingIndex;
  const actionsDisabled = !hasSource || busy;
  const statusMeta = getIndexStatusMeta({
    hasSource,
    indexing: indexingPhotos,
    clearing: clearingIndex,
    pending,
    errors,
    total
  });
  const hint = getIndexPanelHint({ hasSource, total });

  // Siempre habilitado: ademas de las pendientes, "Actualizar" reintenta las
  // fotos con error y aplica los ajustes de indexado que hayan cambiado.
  const indexLabel = indexingPhotos
    ? "Analizando fotos..."
    : pending > 0
      ? `Indexar ${formatCount(pending)} pendientes`
      : errors > 0
        ? "Reintentar fotos con error"
        : "Actualizar fotos";

  return (
    <section className="index-panel" aria-label="Catalogo de rostros">
      <div className="index-panel-head">
        <span className="index-panel-title">Catalogo de rostros</span>
        <span className={`sourcepad-chip sourcepad-chip-${statusMeta.tone}`}>{statusMeta.label}</span>
        <IndexSummary summary={summary} />
      </div>

      {hint ? <p className="index-panel-hint">{hint}</p> : null}

      {errors > 0 ? (
        <div className="index-error-panel" role="alert">
          <div className="index-error-panel-head">
            <span className="index-error-panel-title">
              {formatCount(errors)} {errors === 1 ? "foto no se pudo indexar" : "fotos no se pudieron indexar"}
            </span>
            {typeof onShowErrorPhotos === "function" && !errorFilterActive ? (
              <button type="button" className="btn btn-secondary btn-inline" onClick={onShowErrorPhotos}>
                Ver solo con error
              </button>
            ) : null}
          </div>

          {errorSamples.length > 0 ? (
            errorSamples.map((sample) => (
              <PhotoErrorDetail
                key={sample.message}
                message={sample.message}
                label={`${formatCount(sample.count)} ${Number(sample.count) === 1 ? "foto" : "fotos"}`}
              />
            ))
          ) : (
            <p className="index-panel-hint">
              Sin mensaje registrado (las fotos que no se pueden leer no traen uno). Desplega el estado
              en la lista para ver el detalle por foto, o reindexa para que se registre la causa.
            </p>
          )}
        </div>
      ) : null}

      <div className="index-panel-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onIndexPhotos()}
          disabled={actionsDisabled || total === 0}
        >
          {indexLabel}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onReindexAll}
          disabled={actionsDisabled || total === 0}
        >
          Reindexar todo
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onClearIndex}
          disabled={actionsDisabled}
        >
          {clearingIndex ? "Limpiando..." : "Limpiar catalogo"}
        </button>

        {indexingPhotos ? (
          <div className="index-progress" role="status" aria-live="polite">
            <div className="index-progress-track" aria-hidden="true">
              <span className="index-progress-bar" style={{ width: `${indexingProgressPercent}%` }} />
            </div>
            <p className="meta">{indexingProgressLabel}</p>
          </div>
        ) : indexingMessage ? (
          <p className="status status-success index-panel-message" aria-live="polite">
            {indexingMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
