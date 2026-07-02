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

function DiagnosticBlock({ label, children }) {
  return (
    <section className="photos-filter-panel">
      <p className="field-label">{label}</p>
      {children}
    </section>
  );
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

export default function DiagnosticsView({ diagnostics }) {
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
  const overviewItems = [
    { label: "Fotos sourcepad", value: formatCount(diagnostics.sourcepad.totalPhotos) },
    { label: "Indice total", value: formatCount(indexSummary.totalPhotos) },
    { label: "Indexadas", value: formatCount(indexSummary.indexedPhotos) },
    { label: "Preview", value: formatCount(diagnostics.preview.photos.length) }
  ];
  const sourcepadItems = [
    { label: "Detectadas", value: formatCount(diagnostics.sourcepad.totalPhotos) },
    { label: "Muestra", value: `${formatCount(diagnostics.sourcepad.loadedPhotos)}/${diagnostics.sourcePhotoSampleLimit}` },
    { label: "Configurado", value: diagnostics.sourcepad.configured ? "Si" : "No" },
    { label: "Valido", value: diagnostics.sourcepad.valid ? "Si" : "No" }
  ];
  const indexItems = [
    { label: "Total", value: formatCount(indexSummary.totalPhotos) },
    { label: "Rastreadas", value: formatCount(indexSummary.trackedPhotos) },
    { label: "Pendientes", value: formatCount(indexSummary.pendingPhotos) },
    { label: "Con error", value: formatCount(indexErrorTotal) }
  ];

  return (
    <article className="operator-card">
      <p className="eyebrow">Operador Lifibav3</p>
      <h1>Diagnostico</h1>
      <p className="intro">
        Estado de IPC, sourcepad, indice facial y ultima preview enviada al reproductor.
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
            {diagnostics.rescanning ? "Reescaneando..." : "Reescanear sourcepad"}
          </button>
        ) : null}
        <span className="meta">Ultima verificacion: {formatDateTime(diagnostics.checkedAt)}</span>
      </div>

      <MetricGrid label="Resumen operativo de diagnostico" items={overviewItems} />

      <DiagnosticBlock label="Electron IPC">
        <p className={getStatusClassName(diagnostics.ipc.ok)}>{diagnostics.ipc.message}</p>
        {diagnostics.ipc.detail ? <p className="meta">{diagnostics.ipc.detail}</p> : null}
      </DiagnosticBlock>

      <DiagnosticBlock label="Sourcepad">
        <p className={getStatusClassName(sourcepadOk)}>{diagnostics.sourcepad.message}</p>
        <MetricGrid label="Conteos sourcepad" items={sourcepadItems} />
        {diagnostics.sourcepad.rawPath || diagnostics.sourcepad.path ? (
          <p className="meta">Ruta guardada: {diagnostics.sourcepad.rawPath || diagnostics.sourcepad.path}</p>
        ) : null}
        <p className="meta">
          Muestra solicitada: {diagnostics.sourcepad.loadedPhotos}/{diagnostics.sourcepad.totalPhotos} fotos, limit{" "}
          {diagnostics.sourcePhotoSampleLimit}
        </p>
        {diagnostics.sourcepad.samplePhotos.length > 0 ? (
          <ul>
            {diagnostics.sourcepad.samplePhotos.map((photo, index) => (
              <li key={`${photo.path || photo.name}-${index}`} className="meta">
                {getPhotoLabel(photo)}
              </li>
            ))}
          </ul>
        ) : null}
      </DiagnosticBlock>

      <DiagnosticBlock label="Smoke sourcepad">
        <p className={getStatusClassName(sourcepadSmoke.ok)}>{sourcepadSmoke.message}</p>
        {sourcepadSmoke.detail ? <p className="meta">{sourcepadSmoke.detail}</p> : null}
        <p className={getOptionalStatusClassName(sourcepadWatch)}>{sourcepadWatch.message}</p>
        {sourcepadWatch.detail ? <p className="meta">{sourcepadWatch.detail}</p> : null}
        {sourcepadRescan.message ? <p className="meta">{sourcepadRescan.message}</p> : null}
        {sourcepadRescan.detail ? <p className="meta">{sourcepadRescan.detail}</p> : null}
      </DiagnosticBlock>

      <DiagnosticBlock label="Indice facial">
        <p className={getStatusClassName(indexOk)}>{diagnostics.index.message}</p>
        <MetricGrid label="Conteos del indice facial" items={indexItems} />
        <IndexSummary summary={diagnostics.index.summary} />
        {diagnostics.index.indexDir ? <p className="meta">Directorio indice: {diagnostics.index.indexDir}</p> : null}
        {diagnostics.index.sourcePath ? <p className="meta">Sourcepad del indice: {diagnostics.index.sourcePath}</p> : null}
      </DiagnosticBlock>

      <DiagnosticBlock label="Ultima preview">
        <p className={previewOk ? "status status-success" : "status status-error"}>{diagnostics.preview.message}</p>
        <p className="meta">Actualizada: {formatDateTime(diagnostics.preview.updatedAt)}</p>
        <p className="meta">Edad de ultima preview: {previewAge}</p>
        {diagnostics.preview.photos.length > 0 ? (
          <ul>
            {diagnostics.preview.photos.slice(0, 5).map((photo, index) => (
              <li key={`${photo.photoPath || photo.url}-${index}`} className="meta">
                {getPhotoLabel(photo)}
              </li>
            ))}
          </ul>
        ) : null}
      </DiagnosticBlock>

      <DiagnosticBlock label="Mensajes de error">
        {diagnostics.errors.length > 0 ? (
          diagnostics.errors.map((error, index) => (
            <p key={`${error}-${index}`} className="status status-error">
              {error}
            </p>
          ))
        ) : (
          <p className="status status-success">Sin errores en la verificacion.</p>
        )}
      </DiagnosticBlock>
    </article>
  );
}
