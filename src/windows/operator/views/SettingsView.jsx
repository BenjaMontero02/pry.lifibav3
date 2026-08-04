export default function SettingsView({
  sourcePath,
  loading,
  saving,
  picking,
  canSave,
  hasChanges,
  status,
  statusClassName,
  onSourcePathChange,
  onPickFolder,
  onSave,
  faceSizePx,
  faceDetScore,
  indexLoading,
  indexSaving,
  indexStatus,
  onFaceSizePxChange,
  onFaceDetScoreChange,
  onIndexSettingsSave
}) {
  return (
    <article className="operator-card">
      <p className="eyebrow">Configuracion inicial</p>
      <h1>Carpeta de fotos</h1>
      <p className="intro">
        Elegi la carpeta donde estan las fotos del evento. El sistema va a buscar todas las imagenes ahi.
      </p>

      <label className="field-label" htmlFor="sourcepad-path">
        Ruta de la carpeta
      </label>
      <div className="path-row">
        <input
          id="sourcepad-path"
          className="path-input"
          value={sourcePath}
          onChange={(event) => onSourcePathChange(event.target.value)}
          placeholder={loading ? "Cargando..." : "Todavia no hay carpeta seleccionada"}
          disabled={loading || saving}
          autoComplete="off"
          spellCheck={false}
          name="sourcepadPath"
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onPickFolder}
          disabled={loading || saving || picking}
        >
          {picking ? "Abriendo..." : "Elegir carpeta"}
        </button>
      </div>

      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave}>
          {saving ? "Guardando..." : "Guardar configuracion"}
        </button>
        <span className="meta">{hasChanges ? "Cambios sin guardar" : "Configuracion guardada"}</span>
      </div>

      {status.message ? (
        <p className={statusClassName} aria-live="polite">
          {status.message}
        </p>
      ) : null}

      <hr style={{ margin: "1.5rem 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h2>Deteccion de rostros</h2>
      <p className="intro">
        Ajusta que tan precisa es la busqueda de rostros. Un valor bajo encuentra mas caras pero puede tener errores.
        Un valor alto solo encuentra rostros muy claros.
      </p>

      {indexLoading ? (
        <p className="meta">Cargando ajustes...</p>
      ) : (
        <>
          <label className="field-label" htmlFor="face-size-slider">
            Tamano minimo de rostro ({faceSizePx} px)
          </label>
          <input
            id="face-size-slider"
            className="settings-slider"
            type="range"
            min="10"
            max="200"
            step="1"
            value={faceSizePx}
            onChange={(event) => onFaceSizePxChange(Number(event.target.value))}
          />
          <div className="slider-labels">
            <span>10 px (muy chicas)</span>
            <span>200 px (solo grandes)</span>
          </div>

          <label className="field-label" htmlFor="det-score-slider">
            Precision de deteccion ({faceDetScore.toFixed(2)})
          </label>
          <input
            id="det-score-slider"
            className="settings-slider"
            type="range"
            min="0.05"
            max="0.99"
            step="0.01"
            value={faceDetScore}
            onChange={(event) => onFaceDetScoreChange(Number(event.target.value))}
          />
          <div className="slider-labels">
            <span>0.05 (menos preciso)</span>
            <span>0.99 (mas preciso)</span>
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onIndexSettingsSave}
              disabled={indexSaving}
            >
              {indexSaving ? "Guardando..." : "Guardar ajustes"}
            </button>
          </div>

          {indexStatus.message ? (
            <p className={`status ${indexStatus.type === "success" ? "status-success" : indexStatus.type === "error" ? "status-error" : ""}`} aria-live="polite">
              {indexStatus.message}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}
