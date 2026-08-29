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
  printingPhotos,
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
  onPrintSelected,
  onSelectAllMatches,
  onClearMatchSelection,
  onToggleMatchSelection
}) {
  const hasMatches = scanMatches.length > 0;
  const selectedCount = selectedMatches.length;
  const feedback = jumpToMatchFeedback.message ? jumpToMatchFeedback : scanStatus;

  return (
    <article className="operator-card operator-card-scan">
      {/* Titulo y controles de camara comparten fila: en 14" cada bloque
          apilado le come una fila entera de fotos a la grilla. */}
      <header className="scan-head">
        <h1>Escanear jugador</h1>
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
          <button type="button" className="btn btn-secondary" onClick={onToggleCamera} disabled={scanCameraStarting}>
            {scanCameraStarting ? "Encendiendo..." : scanCameraActive ? "Apagar camara" : "Prender camara"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onCaptureAndSearch}
            disabled={!scanCameraActive || !scanVideoReady || scanInProgress}
          >
            {scanInProgress ? "Buscando..." : "Capturar y buscar"}
          </button>
        </div>
      </header>

      {/* Con resultados la camara se achica a una ficha para apuntar de nuevo:
          la pantalla pasa a ser de las fotos, que es lo que se esta eligiendo. */}
      <div className={`scan-layout ${hasMatches ? "scan-layout-compact" : ""}`}>
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
            <p className="meta scan-preview-hint">Inicializando camara...</p>
          ) : null}
          <canvas id="scan-canvas" ref={scanCanvasRef} className="scan-canvas" aria-hidden="true" />
        </div>

        <div className="scan-results">
          {hasMatches ? (
            <div className="scan-results-head">
              <p className="scan-results-count">
                {scanMatches.length} {scanMatches.length === 1 ? "foto encontrada" : "fotos encontradas"}
              </p>
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
              <button type="button" className="btn btn-secondary btn-compact" onClick={onJumpToMatch}>
                Ir
              </button>
            </div>
          ) : null}

          {!hasMatches ? (
            <div className="scan-empty">
              <p className="scan-empty-title">Todavia no hay fotos</p>
              <p className="meta">Captura un rostro con la camara para buscar las fotos del jugador.</p>
              {scanStatus.message ? (
                <p
                  className={scanStatus.type === "error" ? "status status-error" : "status status-success"}
                  aria-live="polite"
                >
                  {scanStatus.message}
                </p>
              ) : null}
            </div>
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
                  aria-pressed={selectedMatchKeys.includes(match.key)}
                  aria-label={`Foto ${match.displayNumber}`}
                >
                  <FallbackImage
                    src={match.url}
                    alt={`Foto ${match.displayNumber}`}
                    className="scan-match-image"
                    fallbackLabel="Sin foto"
                    loading="lazy"
                    width="400"
                    height="300"
                  />
                  <span className="scan-match-number" aria-hidden="true">#{match.displayNumber}</span>
                </button>
              ))}
            </div>
          )}

          {/* Las acciones van al pie del panel, no arriba: primero se eligen las
              fotos y despues se actua, y asi no empujan la grilla hacia abajo. */}
          {hasMatches ? (
            <div className="scan-actions">
              {feedback.message ? (
                <p
                  className={`scan-actions-feedback ${feedback.type === "error" ? "status-error" : "status-success"}`}
                  aria-live="polite"
                >
                  {feedback.message}
                </p>
              ) : null}
              <div className="scan-actions-row">
                <p className="scan-selection-count" aria-live="polite">
                  {selectedCount === 0 ? "Toca las fotos para elegir" : `${selectedCount} elegidas`}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={onSelectAllMatches}
                  disabled={selectedCount === scanMatches.length}
                >
                  Todas
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={onClearMatchSelection}
                  disabled={selectedCount === 0}
                >
                  Ninguna
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onSendPreview}
                  disabled={selectedCount === 0 || sendingPreview || printingPhotos}
                >
                  {sendingPreview ? "Enviando..." : "Mostrar en pantalla"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onPrintSelected}
                  disabled={selectedCount === 0 || printingPhotos || sendingPreview}
                >
                  {printingPhotos
                    ? "Preparando..."
                    : selectedCount > 1
                      ? `Imprimir ${selectedCount} fotos`
                      : "Imprimir foto"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
