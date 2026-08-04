export default function IndexSummary({ summary }) {
  const current = summary || {};
  const errorTotal = Number(current.errorPhotos || 0) + Number(current.unreadablePhotos || 0);

  return (
    <div className="index-summary" aria-label="Resumen del catalogo">
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.indexedPhotos || 0)}</span>
        <span className="index-summary-label">Listas</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.pendingPhotos || 0)}</span>
        <span className="index-summary-label">Pendientes</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.photosWithoutFaces || 0)}</span>
        <span className="index-summary-label">Sin rostro</span>
      </div>
      <div
        className="index-summary-item"
        title="Se detecto un rostro pero no cumple con los criterios de calidad"
      >
        <span className="index-summary-value">{Number(current.statusCounts?.faces_filtered || 0)}</span>
        <span className="index-summary-label">Rostro no valido</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{errorTotal}</span>
        <span className="index-summary-label">Con error</span>
      </div>
    </div>
  );
}
