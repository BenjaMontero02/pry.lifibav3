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
  onSave
}) {
  return (
    <article className="operator-card">
      <p className="eyebrow">Operador Lifibav3</p>
      <h1>Configuracion de Sourcepad</h1>
      <p className="intro">
        Selecciona la carpeta local que se usara como sourcepad y guardala en la base de datos de la aplicacion.
      </p>

      <label className="field-label" htmlFor="sourcepad-path">
        Ruta de la carpeta sourcepad
      </label>
      <div className="path-row">
        <input
          id="sourcepad-path"
          className="path-input"
          value={sourcePath}
          onChange={(event) => onSourcePathChange(event.target.value)}
          placeholder={loading ? "Cargando ruta actual..." : "Todavia no hay sourcepad seleccionado"}
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
          {saving ? "Guardando..." : "Guardar en base de datos"}
        </button>
        <span className="meta">{hasChanges ? "Cambios sin guardar" : "Configuracion sincronizada"}</span>
      </div>

      {status.message ? (
        <p className={statusClassName} aria-live="polite">
          {status.message}
        </p>
      ) : null}
    </article>
  );
}
