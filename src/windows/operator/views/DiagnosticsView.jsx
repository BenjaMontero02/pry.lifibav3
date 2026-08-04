import { useState } from "react";
import IndexSummary from "../components/IndexSummary";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "medium"
});

const NUMBER_FORMATTER = new Intl.NumberFormat("es-AR");

function getStatusClassName(isHealthy) {
  return isHealthy ? "status status-success" : "status status-error";
}

function getOptionalStatusClassName(item) {
  if (!item?.available) {
    return "status";
  }
  return getStatusClassName(item.ok !== false);
}

function formatDateTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return "Sin datos";
  }
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function formatCount(value) {
  return NUMBER_FORMATTER.format(Number(value || 0));
}

function formatPreviewAge(updatedAt, checkedAt) {
  const timestamp = Number(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return "Sin datos";
  }
  const reference = Number(checkedAt);
  const elapsedSeconds = Math.max(
    0,
    Math.floor(((Number.isFinite(reference) ? reference : Date.now()) - timestamp) / 1000)
  );
  if (elapsedSeconds < 1) {
    return "Ahora";
  }
  const days = Math.floor(elapsedSeconds / 86400);
  const hours = Math.floor((elapsedSeconds % 86400) / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (days > 0) {
    return `Hace ${days} d ${hours} h`;
  }
  if (hours > 0) {
    return `Hace ${hours} h ${minutes} min`;
  }
  if (minutes > 0) {
    return `Hace ${minutes} min ${seconds} s`;
  }
  return `Hace ${seconds} s`;
}

function getPhotoLabel(photo) {
  return photo?.name || photo?.photoPath || photo?.path || "Foto sin nombre";
}

function MetricGrid({ label, items }) {
  return (
    <div className="index-summary" aria-label={label}>
      {items.map((item) => (
        <div key={item.label} className="index-summary-item">
          <span className="index-summary-value">{item.value}</span>
          <span className="index-summary-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function CollapsibleSection({ id, label, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  return (
    <div className="diag-tech-section">
      <button
        type="button"
        className="diag-tech-section-header"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{label}</span>
        <span className="diag-tech-section-arrow" aria-hidden="true">&#9660;</span>
      </button>
      {open ? (
        <div id={`${id}-body`} className="diag-tech-section-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export default function DiagnosticsView({ diagnostics }) {
  const [techMode, setTechMode] = useState(false);
  const sourcepadOk = diagnostics.sourcepad.valid;
  const indexOk = !diagnostics.errors.some((error) => error.startsWith("Estado del indice"));
  const previewOk = !diagnostics.errors.some((error) => error.startsWith("Preview del reproductor"));
  const sourcepadSmoke = diagnostics.sourcepad.smoke || {};
  const sourcepadWatch = diagnostics.sourcepad.watch || {};
  const sourcepadRescan = diagnostics.sourcepad.rescan || {};
  const indexSummary = diagnostics.index.summary || {};
  const previewAge = formatPreviewAge(diagnostics.preview.updatedAt, diagnostics.checkedAt);
  const indexErrorTotal = Number(indexSummary.errorPhotos || 0) + Number(indexSummary.unreadablePhotos || 0);
  const isBusy = diagnostics.loading || diagnostics.rescanning;
  const hasErrors = diagnostics.errors.length > 0;

  const overviewItems = [
    { label: "Fotos en carpeta", value: formatCount(diagnostics.sourcepad.totalPhotos) },
    { label: "Fotos indexadas", value: formatCount(indexSummary.indexedPhotos) },
    { label: "Fotos en pantalla", value: formatCount(diagnostics.preview.photos.length) },
    { label: "Pendientes", value: formatCount(indexSummary.pendingPhotos) }
  ];

  const indexItems = [
    { label: "Total", value: formatCount(indexSummary.totalPhotos) },
    { label: "Listas", value: formatCount(indexSummary.indexedPhotos) },
    { label: "Pendientes", value: formatCount(indexSummary.pendingPhotos) },
    { label: "Con problema", value: formatCount(indexErrorTotal) }
  ];

  return (
    <article className="operator-card">
      <p className="eyebrow">Soporte tecnico</p>
      <h1>Diagnostico del sistema</h1>
      <p className="intro">
        Vista rapida del estado del sistema. Si algo no funciona, esta pantalla ayuda a identificar el problema.
      </p>

      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={diagnostics.refresh}
          disabled={isBusy}
        >
          {diagnostics.loading && !diagnostics.rescanning ? "Refrescando..." : "Refrescar diagnostico"}
        </button>
        {sourcepadRescan.available ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={diagnostics.rescanSourcepad}
            disabled={isBusy}
          >
            {diagnostics.rescanning ? "Reescaneando..." : "Reescanear carpeta"}
          </button>
        ) : null}
        <span className="meta">Ultima verificacion: {formatDateTime(diagnostics.checkedAt)}</span>
      </div>

      <MetricGrid label="Resumen general" items={overviewItems} />

      <IndexSummary summary={diagnostics.index.summary} />

      {hasErrors ? (
        <p className="status status-error" style={{ marginTop: "0.75rem" }}>
          Hay {diagnostics.errors.length} {diagnostics.errors.length === 1 ? "problema detectado" : "problemas detectados"}. Expande "Detalles tecnicos" abajo para verlos.
        </p>
      ) : (
        <p className="status status-success" style={{ marginTop: "0.75rem" }}>
          Sin problemas detectados.
        </p>
      )}

      <hr style={{ margin: "1.25rem 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <div className="diag-tech-banner">
        <span className="diag-tech-banner-icon" aria-hidden="true">&#9888;</span>
        <span>La informacion a continuacion es para personal de soporte tecnico.</span>
      </div>

      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setTechMode((prev) => !prev)}
        style={{ marginBottom: "0.65rem" }}
      >
        {techMode ? "Ocultar detalles tecnicos" : "Mostrar detalles tecnicos"}
      </button>

      {techMode ? (
        <>
          <CollapsibleSection id="diag-ipc" label="Conexion interna (IPC)">
            <p className={getStatusClassName(diagnostics.ipc.ok)}>{diagnostics.ipc.message}</p>
            {diagnostics.ipc.detail ? <p className="meta">{diagnostics.ipc.detail}</p> : null}
          </CollapsibleSection>

          <CollapsibleSection id="diag-sourcepad" label="Carpeta de fotos">
            <p className={getStatusClassName(sourcepadOk)}>{diagnostics.sourcepad.message}</p>
            {diagnostics.sourcepad.rawPath || diagnostics.sourcepad.path ? (
              <p className="meta-mono">Ruta: {diagnostics.sourcepad.rawPath || diagnostics.sourcepad.path}</p>
            ) : null}
            {diagnostics.sourcepad.samplePhotos.length > 0 ? (
              <ul style={{ paddingLeft: "1.2rem", margin: "0.35rem 0 0" }}>
                {diagnostics.sourcepad.samplePhotos.map((photo, index) => (
                  <li key={`${photo.path || photo.name}-${index}`} className="meta">
                    {getPhotoLabel(photo)}
                  </li>
                ))}
              </ul>
            ) : null}
          </CollapsibleSection>

          <CollapsibleSection id="diag-watch" label="Monitoreo de cambios">
            <p className={getStatusClassName(sourcepadSmoke.ok)}>{sourcepadSmoke.message}</p>
            {sourcepadSmoke.detail ? <p className="meta">{sourcepadSmoke.detail}</p> : null}
            <p className={getOptionalStatusClassName(sourcepadWatch)}>{sourcepadWatch.message}</p>
            {sourcepadWatch.detail ? <p className="meta">{sourcepadWatch.detail}</p> : null}
            {sourcepadRescan.message ? <p className="meta">{sourcepadRescan.message}</p> : null}
            {sourcepadRescan.detail ? <p className="meta">{sourcepadRescan.detail}</p> : null}
          </CollapsibleSection>

          <CollapsibleSection id="diag-index" label="Indice facial" defaultOpen>
            <p className={getStatusClassName(indexOk)}>{diagnostics.index.message}</p>
            <MetricGrid label="Conteos del indice facial" items={indexItems} />
            {diagnostics.index.indexDir ? <p className="meta-mono">Directorio: {diagnostics.index.indexDir}</p> : null}
            {diagnostics.index.sourcePath ? <p className="meta-mono">Carpeta: {diagnostics.index.sourcePath}</p> : null}
          </CollapsibleSection>

          <CollapsibleSection id="diag-preview" label="Ultima seleccion enviada">
            <p className={previewOk ? "status status-success" : "status status-error"}>{diagnostics.preview.message}</p>
            <p className="meta">Actualizada: {formatDateTime(diagnostics.preview.updatedAt)}</p>
            <p className="meta">Antiguedad: {previewAge}</p>
            {diagnostics.preview.photos.length > 0 ? (
              <ul style={{ paddingLeft: "1.2rem", margin: "0.35rem 0 0" }}>
                {diagnostics.preview.photos.slice(0, 5).map((photo, index) => (
                  <li key={`${photo.photoPath || photo.url}-${index}`} className="meta">
                    {getPhotoLabel(photo)}
                  </li>
                ))}
              </ul>
            ) : null}
          </CollapsibleSection>

          <CollapsibleSection id="diag-errors" label={`Errores (${diagnostics.errors.length})`} defaultOpen={hasErrors}>
            {diagnostics.errors.length > 0 ? (
              diagnostics.errors.map((error, index) => (
                <p key={`${error}-${index}`} className="status status-error">
                  {error}
                </p>
              ))
            ) : (
              <p className="status status-success">Sin errores en la verificacion.</p>
            )}
          </CollapsibleSection>
        </>
      ) : null}
    </article>
  );
}
