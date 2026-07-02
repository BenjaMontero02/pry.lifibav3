export default function IndexSummary({ summary }) {
  const current = summary || {};
  const errorTotal = Number(current.errorPhotos || 0) + Number(current.unreadablePhotos || 0);

  return (
    <div className="index-summary" aria-label="Estado del indice facial">
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.indexedPhotos || 0)}</span>
        <span className="index-summary-label">Indexadas</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.pendingPhotos || 0)}</span>
        <span className="index-summary-label">Pendientes</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{Number(current.photosWithoutFaces || 0)}</span>
        <span className="index-summary-label">Sin cara</span>
      </div>
      <div
        className="index-summary-item"
        title="Se detectaron caras pero se descartaron por tamano o confianza insuficiente"
      >
        <span className="index-summary-value">{Number(current.statusCounts?.faces_filtered || 0)}</span>
        <span className="index-summary-label">Cara descartada</span>
      </div>
      <div className="index-summary-item">
        <span className="index-summary-value">{errorTotal}</span>
        <span className="index-summary-label">Con error</span>
      </div>
    </div>
  );
}
