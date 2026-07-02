import FallbackImage from "../../../shared/FallbackImage";

export default function ScanPlayerView({
  availableCameras,
  selectedCameraId,
  scanThreshold,
  scanCameraStarting,
  scanCameraActive,
  scanVideoReady,
  scanInProgress,
  scanMatches,
  selectedMatchKeys,
  selectedMatches,
  sendingPreview,
  scanStatus,
  jumpToMatchValue,
  jumpToMatchFeedback,
  scanVideoRef,
  scanCanvasRef,
  matchCardRefs,
  onSelectedCameraIdChange,
  onScanThresholdChange,
  onToggleCamera,
  onCaptureAndSearch,
  onVideoLoadedMetadata,
  onJumpToMatchValueChange,
  onJumpToMatch,
  onSendPreview,
  onToggleMatchSelection
}) {
  return (
    <article className="operator-card operator-card-scan">
      <p className="eyebrow">Operador Lifibav3</p>
      <h1>Escanear jugador</h1>
      <p className="intro">
        Captura un frame desde webcam (DroidCam/Camo), lo manda a InsightFace + FAISS y devuelve miniaturas ordenadas por
        similitud coseno.
      </p>

      <div className="scan-toolbar">
        <label className="field-label" htmlFor="camera-select">
          Camara
        </label>
        <select
          id="camera-select"
          className="scan-select"
          value={selectedCameraId}
          onChange={(event) => onSelectedCameraIdChange(event.target.value)}
          name="cameraId"
        >
          {availableCameras.length === 0 ? <option value="">Camara por defecto</option> : null}
          {availableCameras.map((camera, index) => (
            <option key={camera.deviceId || String(index)} value={camera.deviceId || ""}>
              {camera.label || `Camara ${index + 1}`}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="threshold-slider">
          Umbral ({scanThreshold.toFixed(2)})
        </label>
        <input
          id="threshold-slider"
          className="scan-threshold"
          type="range"
          step="0.01"
          min="0"
          max="1"
          value={scanThreshold}
          onChange={(event) => onScanThresholdChange(Number(event.target.value))}
          name="similarityThreshold"
        />
        <button type="button" className="btn btn-secondary" onClick={onToggleCamera} disabled={scanCameraStarting}>
          {scanCameraStarting ? "Encendiendo..." : scanCameraActive ? "Apagar camara" : "Prender camara"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCaptureAndSearch}
          disabled={!scanCameraActive || !scanVideoReady || scanInProgress}
        >
          {scanInProgress ? "Escaneando..." : "Capturar y buscar"}
        </button>
      </div>

      <div className="scan-layout">
        <div className="scan-preview">
          <video
            id="scan-video"
            ref={scanVideoRef}
            className="scan-video"
            autoPlay
            muted
            playsInline
            onLoadedMetadata={onVideoLoadedMetadata}
          />
          {scanCameraStarting || (scanCameraActive && !scanVideoReady) ? (
            <p className="meta">Inicializando stream de webcam...</p>
          ) : null}
          <canvas id="scan-canvas" ref={scanCanvasRef} className="scan-canvas" aria-hidden="true" />
        </div>

        <div className="scan-results">
          <p className="field-label">Coincidencias</p>
          {scanMatches.length > 0 ? (
            <div className="scan-jump-row">
              <label className="field-label" htmlFor="jump-to-match-input">
                Ir a foto #
              </label>
              <input
                id="jump-to-match-input"
                className="scan-jump-input"
                type="number"
                min="1"
                step="1"
                value={jumpToMatchValue}
                onChange={(event) => onJumpToMatchValueChange(event.target.value)}
                name="jumpToMatch"
                inputMode="numeric"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onJumpToMatch();
                  }
                }}
                placeholder="Ej: 4"
              />
              <button type="button" className="btn btn-secondary" onClick={onJumpToMatch}>
                Ir
              </button>
            </div>
          ) : null}
          {jumpToMatchFeedback.message ? (
            <p
              className={jumpToMatchFeedback.type === "error" ? "status status-error" : "status status-success"}
              aria-live="polite"
            >
              {jumpToMatchFeedback.message}
            </p>
          ) : null}
          {selectedMatches.length > 0 ? (
            <div className="scan-preview-cta">
              <p className="meta">{selectedMatches.length} fotos seleccionadas</p>
              <button type="button" className="btn btn-primary" onClick={onSendPreview} disabled={sendingPreview}>
                {sendingPreview ? "Enviando..." : "Previsualizacion"}
              </button>
            </div>
          ) : null}
          {scanStatus.message ? (
            <p className={scanStatus.type === "error" ? "status status-error" : "status status-success"} aria-live="polite">
              {scanStatus.message}
            </p>
          ) : null}

          {scanMatches.length === 0 ? (
            <p className="status">Todavia no hay resultados para mostrar.</p>
          ) : (
            <div className="scan-matches-grid">
              {scanMatches.map((match) => (
                <button
                  key={match.key}
                  type="button"
                  ref={(element) => {
                    if (element) {
                      matchCardRefs.current.set(match.key, element);
                    } else {
                      matchCardRefs.current.delete(match.key);
                    }
                  }}
                  className={`scan-match-card ${selectedMatchKeys.includes(match.key) ? "scan-match-card-selected" : ""}`}
                  onClick={() => onToggleMatchSelection(match.key)}
                >
                  <span className="scan-match-number" aria-label={`Referencia ${match.displayNumber}`}>
                    #{match.displayNumber}
                  </span>
                  <FallbackImage
                    src={match.url}
                    alt={match.photoPath}
                    className="scan-match-image"
                    fallbackLabel="Sin foto"
                    loading="lazy"
                    width="400"
                    height="300"
                  />
                  <div className="scan-match-meta">
                    <p className="scan-match-score">Similitud: {(match.similarity || 0).toFixed(3)}</p>
                    <p className="scan-match-path" title={match.photoPath}>
                      {match.photoPath}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
