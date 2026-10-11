import { useEffect } from "react";
import FallbackImage from "../../../shared/FallbackImage";
import isEditableTarget from "../../../shared/isEditableTarget";

export default function ScanPlayerView({
  availableCameras,
  selectedCameraId,
  scanThreshold,
  scanQueryExpansion,
  scanMultiAngle,
  scanPrompt,
  facePreview,
  indexingPhotos,
  scanCameraStarting,
  scanCameraActive,
  scanVideoReady,
  scanInProgress,
  scanMatches,
  selectedMatchKeys,
  selectedMatches,
  sendingPreview,
  printingPhotos,
  clearingPlayer,
  scanStatus,
  jumpToMatchValue,
  jumpToMatchFeedback,
  scanVideoRef,
  scanCanvasRef,
  matchCardRefs,
  onSelectedCameraIdChange,
  onScanThresholdChange,
  onScanQueryExpansionChange,
  onScanMultiAngleChange,
  onToggleCamera,
  onCaptureAndSearch,
  onCancelScan,
  onVideoLoadedMetadata,
  onJumpToMatchValueChange,
  onJumpToMatch,
  onSendPreview,
  onPrintSelected,
  onNewPlayer,
  onSelectAllMatches,
  onClearMatchSelection,
  onToggleMatchSelection
}) {
  const hasMatches = scanMatches.length > 0;
  const selectedCount = selectedMatches.length;
  const canCapture = scanCameraActive && scanVideoReady && !scanInProgress && !indexingPhotos;
  const canPrint = selectedCount > 0 && !printingPhotos && !sendingPreview;
  const canNewPlayer = !clearingPlayer && !printingPhotos;

  // Atajos solo mientras esta vista esta montada. Se ignoran si el foco esta en
  // un campo de texto o select (ahi Ctrl+Enter/Esc tienen su propio uso).
  // Las teclas reservadas siempre frenan la accion nativa (Ctrl+P abriria la
  // impresion de la ventana), aunque la accion no este disponible ahora.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }
      const key = String(event.key || "").toLowerCase();
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;

      if (ctrl && !event.shiftKey && key === "enter") {
        event.preventDefault();
        if (canCapture) {
          onCaptureAndSearch();
        }
        return;
      }
      if (ctrl && !event.shiftKey && key === "p") {
        event.preventDefault();
        if (canPrint) {
          onPrintSelected();
        }
        return;
      }
      if (ctrl && event.shiftKey && key === "a") {
        event.preventDefault();
        if (hasMatches && selectedCount < scanMatches.length) {
          onSelectAllMatches();
        }
        return;
      }
      if (ctrl && !event.shiftKey && key === "n") {
        event.preventDefault();
        if (canNewPlayer) {
          onNewPlayer();
        }
        return;
      }
      if (!ctrl && !event.shiftKey && key === "escape" && scanInProgress && scanPrompt) {
        event.preventDefault();
        onCancelScan();
        return;
      }
      if (!ctrl && !event.shiftKey && key === "escape" && selectedCount > 0) {
        event.preventDefault();
        onClearMatchSelection();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    canCapture,
    canNewPlayer,
    canPrint,
    hasMatches,
    onCancelScan,
    onCaptureAndSearch,
    onClearMatchSelection,
    onNewPlayer,
    onPrintSelected,
    onSelectAllMatches,
    scanInProgress,
    scanMatches.length,
    scanPrompt,
    selectedCount
  ]);

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
            disabled={!canCapture}
            title="Atajo: Ctrl+Enter"
          >
            {scanInProgress ? "Buscando..." : "Capturar y buscar"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onNewPlayer}
            disabled={!canNewPlayer}
            title="Atajo: Ctrl+N. Vacia la pantalla del jugador y los resultados"
          >
            {clearingPlayer ? "Limpiando..." : "Nuevo jugador"}
          </button>
        </div>
      </header>

      {indexingPhotos ? (
        <p className="status" role="status">
          Se estan analizando fotos. La busqueda se habilita cuando termine el analisis.
        </p>
      ) : null}

      {/* Plegado por defecto: se toca poco durante el evento y abierto le quita
          tres filas a la grilla en una pantalla de 14". */}
      <details className="scan-tuning-panel">
        <summary>
          Ajustes de busqueda (umbral {scanThreshold.toFixed(2)}
          {scanQueryExpansion ? " · ampliada" : ""}
          {scanMultiAngle ? " · 3 angulos" : ""})
        </summary>
        <div className="scan-tuning">
          <div className="scan-tuning-threshold">
            <label className="field-label" htmlFor="scan-threshold-slider">
              Umbral de coincidencia ({scanThreshold.toFixed(2)})
            </label>
            <input
              id="scan-threshold-slider"
              className="settings-slider"
              type="range"
              min="0.2"
              max="0.8"
              step="0.01"
              value={scanThreshold}
              onChange={(event) => onScanThresholdChange(Number(event.target.value))}
            />
            <div className="slider-labels">
              <span>0.20 (trae mas fotos, mas errores)</span>
              <span>0.80 (solo muy parecidas)</span>
            </div>
          </div>
          <label className="scan-tuning-toggle">
            <input
              type="checkbox"
              checked={scanQueryExpansion}
              onChange={(event) => onScanQueryExpansionChange(event.target.checked)}
            />
            <span>
              Busqueda ampliada (experimental): usa las fotos mas seguras para encontrar otras de perfil o
              borrosas. Puede traer fotos de otra persona parecida.
            </span>
          </label>
          <label className="scan-tuning-toggle">
            <input
              type="checkbox"
              checked={scanMultiAngle}
              onChange={(event) => onScanMultiAngleChange(event.target.checked)}
            />
            <span>
              Escaneo en 3 angulos (experimental): guia al jugador para mirar de frente y girar un poco a cada
              lado, y busca con cada angulo. Ayuda con fotos de perfil; tarda unos 9 segundos. Esc cancela.
            </span>
          </label>
        </div>
      </details>

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
          {scanPrompt ? (
            <p className="scan-prompt-overlay" role="status" aria-live="assertive">
              {scanPrompt}
            </p>
          ) : null}
          {facePreview && !scanPrompt ? (
            <p className={`scan-face-indicator scan-face-${facePreview.state}`} aria-live="polite">
              {facePreview.message}
            </p>
          ) : null}
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
              <p className="scan-shortcuts">
                Atajos: Ctrl+Enter capturar y buscar · Ctrl+P imprimir · Ctrl+Shift+A seleccionar todas · Esc
                limpiar seleccion o cancelar el escaneo guiado · Ctrl+N nuevo jugador
              </p>
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
                    src={match.thumbUrl}
                    alt={`Foto ${match.displayNumber}`}
                    className="scan-match-image"
                    fallbackLabel="Sin foto"
                    loading="lazy"
                    width="400"
                    height="300"
                  />
                  <span className="scan-match-number" aria-hidden="true">#{match.displayNumber}</span>
                  {match.viaSideAngle ? (
                    <span className="scan-match-angle" title="Solo la encontro un angulo girado: revisala">
                      angulo
                    </span>
                  ) : null}
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
                  title="Atajo: Ctrl+Shift+A"
                >
                  Todas
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={onClearMatchSelection}
                  disabled={selectedCount === 0}
                  title="Atajo: Esc"
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
                  disabled={!canPrint}
                  title="Atajo: Ctrl+P"
                >
                  {printingPhotos
                    ? "Confirmá en el diálogo..."
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
