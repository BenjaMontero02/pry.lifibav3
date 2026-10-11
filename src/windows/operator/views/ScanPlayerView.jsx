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

  return (
    <article className="operator-card operator-card-scan">
      <p className="eyebrow">Busqueda facial</p>
      <h1>Escanear jugador</h1>
      <p className="intro">
        Captura el rostro del jugador con la camara y encontra todas sus fotos del evento.
      </p>
      <p className="scan-shortcuts">
        Atajos: Ctrl+Enter capturar y buscar · Ctrl+P imprimir · Ctrl+Shift+A seleccionar todas · Esc
        limpiar seleccion · Ctrl+N nuevo jugador
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

      {indexingPhotos ? (
        <p className="status" role="status">
          Se estan analizando fotos. La busqueda se habilita cuando termine el analisis.
        </p>
      ) : null}

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
            lado, y busca con cada angulo. Ayuda con fotos de perfil; tarda unos 6 segundos. Esc cancela.
          </span>
        </label>
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
          {scanPrompt ? (
            <p className="scan-prompt-overlay" role="status" aria-live="assertive">
              {scanPrompt}
            </p>
          ) : null}
          {scanCameraStarting || (scanCameraActive && !scanVideoReady) ? (
            <p className="meta">Inicializando camara...</p>
          ) : null}
          <canvas id="scan-canvas" ref={scanCanvasRef} className="scan-canvas" aria-hidden="true" />
        </div>

        <div className="scan-results" style={{ position: "relative" }}>
          <p className="field-label">Resultados</p>

          {hasMatches ? (
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

          {hasMatches ? (
            <div className="scan-preview-cta">
              <p className="meta">
                {selectedCount === 0
                  ? "Toca las fotos para elegir las que se imprimen"
                  : `${selectedCount} ${selectedCount === 1 ? "foto seleccionada" : "fotos seleccionadas"}`}
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onSelectAllMatches}
                disabled={selectedCount === scanMatches.length}
                title="Atajo: Ctrl+Shift+A"
              >
                Seleccionar todas
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClearMatchSelection}
                disabled={selectedCount === 0}
                title="Atajo: Esc"
              >
                Limpiar seleccion
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
          ) : null}

          {scanStatus.message ? (
            <p className={scanStatus.type === "error" ? "status status-error" : "status status-success"} aria-live="polite">
              {scanStatus.message}
            </p>
          ) : null}

          {!hasMatches ? (
            <p className="status">Todavia no hay resultados. Captura un rostro para buscar.</p>
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
        </div>
      </div>
    </article>
  );
}
