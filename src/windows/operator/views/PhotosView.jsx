import { useMemo, useState } from "react";
import IndexPanel from "../components/IndexPanel";
import PhotoRow from "../components/PhotoRow";
import SourcepadDetails from "../components/SourcepadDetails";
import { PHOTO_STATUS_FILTERS, EMPTY_PHOTO_STATUS_COUNTS } from "../../../shared/photoStatus";
import { formatCount } from "../../../shared/formatters";

function normalizeStatusCounts(value) {
  return PHOTO_STATUS_FILTERS.reduce((counts, filter) => {
    counts[filter.id] = Number(value?.[filter.id] || 0);
    return counts;
  }, {});
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
    () => normalizeStatusCounts(photosMeta.statusCounts || EMPTY_PHOTO_STATUS_COUNTS),
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
        errorFilterActive={photoStatusFilter === "error"}
        onIndexPhotos={onIndexPhotos}
        onReindexAll={onReindexAll}
        onClearIndex={onClearIndex}
        onShowErrorPhotos={() => handleStatusFilterSelect("error")}
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
