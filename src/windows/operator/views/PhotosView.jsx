import { useMemo, useState } from "react";
import IndexSummary from "../components/IndexSummary";
import PhotoRow from "../components/PhotoRow";

const PHOTO_STATUS_FILTERS = [
  { id: "all", label: "Todas" },
  { id: "pending", label: "Pendientes" },
  { id: "indexed", label: "Indexadas" },
  { id: "no_faces", label: "Sin cara" },
  { id: "faces_filtered", label: "Cara descartada" },
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
    return { label: "Sin sourcepad", tone: "muted" };
  }
  if (watchStatus.lastError) {
    return { label: "Error", tone: "error" };
  }
  if (watchStatus.pendingRescan) {
    return { label: "Reescaneando", tone: "busy" };
  }
  if (watchStatus.dirty) {
    return { label: "Cambios pendientes", tone: "busy" };
  }
  if (watchStatus.watching) {
    return { label: "Monitoreando", tone: "ok" };
  }

  return { label: "Watcher inactivo", tone: "muted" };
}

function getPrewarmStatusMeta(prewarm) {
  const pending = Number(prewarm?.pending || 0);
  const failed = Number(prewarm?.failed || 0);
  const total = Number(prewarm?.total || 0);

  if (failed > 0) {
    return { label: "Con fallas", tone: "error" };
  }
  if (pending > 0) {
    return { label: "Prewarm activo", tone: "busy" };
  }
  if (total > 0) {
    return { label: "Prewarm listo", tone: "ok" };
  }

  return { label: "Sin actividad", tone: "muted" };
}

function getChangeText(watchStatus) {
  const lastEvent = watchStatus?.lastEvent || {};
  const eventType = lastEvent.eventType || "cambio";
  const filename = lastEvent.filename ? ` - ${lastEvent.filename}` : "";
  const timestamp = watchStatus?.lastChangedAt || lastEvent.noticedAt;

  if (!timestamp && !lastEvent.filename) {
    return "Cambios: sin cambios detectados";
  }

  return `Cambios: ${eventType}${filename} - ${formatDateTime(timestamp)}`;
}

function SourcepadRuntimePanel({ watchStatus, thumbnailPrewarm }) {
  const currentWatchStatus = watchStatus || {};
  const prewarm = thumbnailPrewarm || currentWatchStatus.thumbnailPrewarm || {};
  const watcherStatus = getWatcherStatusMeta(currentWatchStatus);
  const prewarmStatus = getPrewarmStatusMeta(prewarm);
  const lastError = currentWatchStatus.lastError ||
    (Number(prewarm.failed || 0) > 0 ? "Hay thumbnails fallidos en el ultimo prewarm." : "");
  const completed = Number(prewarm.completed || 0);
  const failed = Number(prewarm.failed || 0);
  const pending = Number(prewarm.pending || 0);

  return (
    <section className="sourcepad-runtime" aria-label="Estado del watcher sourcepad y thumbnails">
      <div className="sourcepad-runtime-grid">
        <div className="sourcepad-runtime-panel">
          <div className="sourcepad-runtime-head">
            <span className="sourcepad-runtime-title">Watcher sourcepad</span>
            <span className={`sourcepad-chip sourcepad-chip-${watcherStatus.tone}`}>
              {watcherStatus.label}
            </span>
          </div>
          <p className="sourcepad-runtime-line" title={getChangeText(currentWatchStatus)}>
            {getChangeText(currentWatchStatus)}
          </p>
          <p className="meta">Ultimo escaneo: {formatDateTime(currentWatchStatus.lastScannedAt)}</p>
        </div>

        <div className="sourcepad-runtime-panel">
          <div className="sourcepad-runtime-head">
            <span className="sourcepad-runtime-title">Thumbnails</span>
            <span className={`sourcepad-chip sourcepad-chip-${prewarmStatus.tone}`}>
              {prewarmStatus.label}
            </span>
          </div>
          <div className="sourcepad-thumbnail-stats" aria-label="Progreso de prewarm de thumbnails">
            <span>
              <strong>{formatCount(pending)}</strong>
              <small>Pendientes</small>
            </span>
            <span>
              <strong>{formatCount(completed)}</strong>
              <small>Completados</small>
            </span>
            <span>
              <strong>{formatCount(failed)}</strong>
              <small>Fallidos</small>
            </span>
          </div>
        </div>
      </div>

      <p className={`sourcepad-runtime-error${lastError ? " sourcepad-runtime-error-active" : ""}`}>
        Ultimo error: <span>{lastError || "sin errores recientes"}</span>
      </p>
    </section>
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
  onUpdatePhotos,
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
  const toolbarCountText = isFilteringByStatus || hasActiveSearch
    ? `${currentTotal} fotos en la vista actual - ${loadedCount} cargadas`
    : `${currentTotal} fotos encontradas - ${loadedCount} cargadas`;
  const filterScopeText = hasActiveSearch
    ? "en la busqueda actual"
    : "en toda la carpeta";
  const emptyPhotosMessage = isFilteringByStatus || hasActiveSearch
    ? `No hay fotos para ${activeFilterLabel.toLowerCase()} ${filterScopeText}.`
    : "No se encontraron fotos en la carpeta origen.";
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
      <p className="eyebrow">Operador Lifibav3</p>
      <h1>Fotos</h1>
      <p className="intro">Listado de fotos detectadas en la carpeta de origen configurada como sourcepad.</p>

      <div className="photos-toolbar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onUpdatePhotos}
          disabled={photosLoading || indexingPhotos || clearingIndex}
        >
          {indexingPhotos ? "Indexando fotos..." : "Actualizar fotos"}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onClearIndex}
          disabled={photosLoading || indexingPhotos || clearingIndex}
        >
          {clearingIndex ? "Limpiando..." : "Limpiar indice"}
        </button>
        <span className="meta">
          {photosPath
            ? toolbarCountText
            : "No hay carpeta sourcepad configurada"}
        </span>
      </div>

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
          placeholder="Nombre o ruta de foto"
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

      <div className="photos-filter-panel">
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
        <p className="photos-filter-note">
          {activeFilterLabel}: {currentTotal} fotos {filterScopeText}. {loadedCount} cargadas
          {hasMorePhotos ? `; quedan ${remainingCount}.` : "."}
        </p>
      </div>

      <SourcepadRuntimePanel
        watchStatus={sourcepadWatchStatus}
        thumbnailPrewarm={thumbnailPrewarm}
      />

      <IndexSummary summary={currentIndexSummary} />

      {photosPath ? (
        <p className="photos-source">
          Carpeta origen: <span>{photosPath}</span>
        </p>
      ) : null}

      {indexingPhotos ? (
        <div className="index-progress" role="status" aria-live="polite">
          <div className="index-progress-track" aria-hidden="true">
            <span className="index-progress-bar" style={{ width: `${indexingProgressPercent}%` }} />
          </div>
          <p className="meta">{indexingProgressLabel}</p>
        </div>
      ) : null}

      {photosError ? (
        <p className="status status-error" aria-live="polite">
          {photosError}
        </p>
      ) : null}
      {indexingMessage ? (
        <p className="status status-success" aria-live="polite">
          {indexingMessage}
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
