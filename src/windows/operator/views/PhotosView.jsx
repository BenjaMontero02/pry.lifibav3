import { useMemo, useState } from "react";
import IndexSummary from "../components/IndexSummary";
import PhotoRow from "../components/PhotoRow";

const PHOTO_STATUS_FILTERS = [
  { id: "all", label: "Todas" },
  { id: "pending", label: "Pendientes" },
  { id: "indexed", label: "Listas" },
  { id: "no_faces", label: "Sin rostro" },
  { id: "faces_filtered", label: "Rostro no valido" },
  { id: "error", label: "Con error" }
];

const EMPTY_STATUS_COUNTS = {
  all: 0,
  pending: 0,
  indexed: 0,
  no_faces: 0,
  faces_filtered: 0,
  error: 0
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "medium"
});

const NUMBER_FORMATTER = new Intl.NumberFormat("es-AR");

function normalizeStatusCounts(value) {
  return PHOTO_STATUS_FILTERS.reduce((counts, filter) => {
    counts[filter.id] = Number(value?.[filter.id] || 0);
    return counts;
  }, {});
}

function formatCount(value) {
  return NUMBER_FORMATTER.format(Number(value || 0));
}

function formatDateTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Sin datos";
  }
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

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

function IndexPanel({
  photosPath,
  photosLoading,
  indexingPhotos,
  indexingProgressPercent,
  indexingProgressLabel,
  indexingMessage,
  clearingIndex,
  currentIndexSummary,
  onIndexPhotos,
  onReindexAll,
  onClearIndex
}) {
  const summary = currentIndexSummary || {};
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

  const indexLabel = indexingPhotos
    ? "Analizando fotos..."
    : pending > 0
      ? `Indexar ${formatCount(pending)} pendientes`
      : "Todo indexado";

  return (
    <section className="index-panel" aria-label="Catalogo de rostros">
      <div className="index-panel-head">
        <span className="index-panel-title">Catalogo de rostros</span>
        <span className={`sourcepad-chip sourcepad-chip-${statusMeta.tone}`}>{statusMeta.label}</span>
        <IndexSummary summary={summary} />
      </div>

      {hint ? <p className="index-panel-hint">{hint}</p> : null}

      <div className="index-panel-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onIndexPhotos()}
          disabled={actionsDisabled || pending === 0}
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

function SourcepadDetails({ watchStatus, thumbnailPrewarm }) {
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

export default function PhotosView({
  photos,
  photosMeta,
  photosPath,
  photosLoading,
  photosError,
  photosSearchDraft,
  photosQuery,
  indexingPhotos,
  indexingProgressPercent,
  indexingProgressLabel,
  indexingMessage,
  clearingIndex,
  currentIndexSummary,
  hasMorePhotos,
  photosScrollRef,
  onIndexPhotos,
  onReindexAll,
  onReloadPhotos,
  onClearIndex,
  onPhotosSearchSubmit,
  onPhotosSearchDraftChange,
  onClearPhotosSearch,
  onPhotosScroll,
  onShowMorePhotos,
  onOpenPhoto
}) {
  const [photoStatusFilter, setPhotoStatusFilter] = useState("all");

  const statusCounts = useMemo(
    () => normalizeStatusCounts(photosMeta.statusCounts || EMPTY_STATUS_COUNTS),
    [photosMeta.statusCounts]
  );

  const activeFilterLabel =
    PHOTO_STATUS_FILTERS.find((filter) => filter.id === photoStatusFilter)?.label || PHOTO_STATUS_FILTERS[0].label;
  const isFilteringByStatus = photoStatusFilter !== "all";
  const hasActiveSearch = Boolean(photosQuery);
  const currentTotal = Number(photosMeta.total || 0);
  const loadedCount = photos.length;
  const remainingCount = Math.max(0, currentTotal - loadedCount);
  const toolbarCountText = `${formatCount(currentTotal)} fotos - ${formatCount(loadedCount)} cargadas`;
  const filterScopeText = hasActiveSearch
    ? "en la busqueda actual"
    : "en la carpeta";
  const emptyPhotosMessage = isFilteringByStatus || hasActiveSearch
    ? `No hay fotos para "${activeFilterLabel.toLowerCase()}" ${filterScopeText}.`
    : "No se encontraron fotos en la carpeta.";
  const sourcepadWatchStatus = photosMeta.sourcepadWatchStatus || {};
  const thumbnailPrewarm = photosMeta.thumbnailPrewarm || sourcepadWatchStatus.thumbnailPrewarm || {};

  const handleStatusFilterSelect = (nextStatusFilter) => {
    setPhotoStatusFilter(nextStatusFilter);
    if (photosScrollRef.current) {
      photosScrollRef.current.scrollTop = 0;
    }
    onPhotosSearchSubmit({
      query: photosQuery,
      statusFilter: nextStatusFilter
    });
  };

  return (
    <article className="operator-card operator-card-photos">
      <header className="photos-header">
        <h1>Fotos del evento</h1>
        <span className="meta">{photosPath ? toolbarCountText : "No hay carpeta configurada"}</span>
      </header>

      <IndexPanel
        photosPath={photosPath}
        photosLoading={photosLoading}
        indexingPhotos={indexingPhotos}
        indexingProgressPercent={indexingProgressPercent}
        indexingProgressLabel={indexingProgressLabel}
        indexingMessage={indexingMessage}
        clearingIndex={clearingIndex}
        currentIndexSummary={currentIndexSummary}
        onIndexPhotos={onIndexPhotos}
        onReindexAll={onReindexAll}
        onClearIndex={onClearIndex}
      />

      <div className="photos-toolbar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onReloadPhotos}
          disabled={photosLoading || indexingPhotos || clearingIndex}
        >
          {photosLoading ? "Recargando..." : "Recargar lista"}
        </button>

        <form
          className="photos-search"
          onSubmit={(event) => onPhotosSearchSubmit(event, { statusFilter: photoStatusFilter })}
        >
          <label className="field-label" htmlFor="photos-search-input">
            Buscar
          </label>
          <input
            id="photos-search-input"
            className="path-input"
            value={photosSearchDraft}
            onChange={(event) => onPhotosSearchDraftChange(event.target.value)}
            placeholder="Nombre de la foto"
            autoComplete="off"
            spellCheck={false}
            name="photosSearch"
          />
          <button type="submit" className="btn btn-secondary" disabled={photosLoading || indexingPhotos}>
            Buscar
          </button>
          {photosQuery ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onClearPhotosSearch({ statusFilter: photoStatusFilter })}
              disabled={photosLoading || indexingPhotos}
            >
              Limpiar
            </button>
          ) : null}
        </form>
      </div>

      <div className="photos-status-filters" role="group" aria-label="Filtrar fotos por estado">
        {PHOTO_STATUS_FILTERS.map((filter) => {
          const isActive = photoStatusFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              className={`photos-filter-btn${isActive ? " photos-filter-btn-active" : ""}`}
              onClick={() => handleStatusFilterSelect(filter.id)}
              aria-pressed={isActive}
            >
              <span>{filter.label}</span>
              <span className="photos-filter-count">{statusCounts[filter.id]}</span>
            </button>
          );
        })}
      </div>

      <SourcepadDetails
        watchStatus={sourcepadWatchStatus}
        thumbnailPrewarm={thumbnailPrewarm}
      />

      {photosError ? (
        <p className="status status-error" aria-live="polite">
          {photosError}
        </p>
      ) : null}

      {!photosLoading && !photosError && photos.length === 0 ? (
        <p className="status">{emptyPhotosMessage}</p>
      ) : null}

      <div className="photos-scroll" ref={photosScrollRef} onScroll={onPhotosScroll}>
        <div className="photos-list" role="list" aria-label="Listado de fotos">
          {photos.map((photo, index) => (
            <PhotoRow key={photo.path} photo={photo} displayIndex={index + 1} onOpen={onOpenPhoto} />
          ))}
        </div>
        {hasMorePhotos ? (
          <div className="photos-more-wrap">
            <button type="button" className="btn btn-secondary photos-more-btn" onClick={onShowMorePhotos}>
              Mostrar mas ({Math.min(photosMeta.limit, remainingCount)})
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
