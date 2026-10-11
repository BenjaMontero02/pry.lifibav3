// Estados de indexado de las fotos. Fuente unica para la UI del operador.

export const PHOTO_STATUS_FILTERS = Object.freeze([
  Object.freeze({ id: "all", label: "Todas" }),
  Object.freeze({ id: "pending", label: "Pendientes" }),
  Object.freeze({ id: "indexed", label: "Listas" }),
  Object.freeze({ id: "no_faces", label: "Sin rostro" }),
  Object.freeze({ id: "faces_filtered", label: "Rostro no valido" }),
  Object.freeze({ id: "error", label: "Con error" })
]);

export const PHOTO_STATUS_FILTER_IDS = Object.freeze(PHOTO_STATUS_FILTERS.map((filter) => filter.id));

export const EMPTY_PHOTO_STATUS_COUNTS = Object.freeze(
  PHOTO_STATUS_FILTER_IDS.reduce((counts, id) => {
    counts[id] = 0;
    return counts;
  }, {})
);

// Forma de `indexSummary` que devuelve main (createPhotoIndexSummaryFromGroupedRows
// y createEmptyPhotoIndexSummary en electron/main.js). La UI lee `statusCounts`.
// main tambien manda `byStatus`, pero ningun componente lo usa.
export const EMPTY_INDEX_SUMMARY = Object.freeze({
  totalPhotos: 0,
  trackedPhotos: 0,
  indexedPhotos: 0,
  photosWithoutFaces: 0,
  unreadablePhotos: 0,
  errorPhotos: 0,
  pendingPhotos: 0,
  statusCounts: EMPTY_PHOTO_STATUS_COUNTS,
  errorSamples: []
});
