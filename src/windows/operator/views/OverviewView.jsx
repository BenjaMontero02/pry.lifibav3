export default function OverviewView() {
  return (
    <article className="operator-card">
      <p className="eyebrow">LifiBA</p>
      <h1>Bienvenido</h1>
      <p className="intro">
        Todo listo para empezar. Primero configura la carpeta en Ajustes, despues anda a Fotos e indexa
        el catalogo. Elegi una seccion en el menu lateral segun lo que necesites hacer.
      </p>
      <ul style={{ paddingLeft: "1.2rem", lineHeight: "1.7", color: "var(--ink-soft)", fontSize: "0.9rem" }}>
        <li><strong style={{ color: "var(--ink)" }}>Ajustes</strong> — Configura la carpeta de fotos del evento</li>
        <li><strong style={{ color: "var(--ink)" }}>Fotos</strong> — Indexa las fotos de la carpeta y revisa sus estados</li>
        <li><strong style={{ color: "var(--ink)" }}>Escanear</strong> — Busca las fotos de un jugador por su rostro</li>
        <li><strong style={{ color: "var(--ink)" }}>Diagnostico</strong> — Verifica que todo funcione correctamente</li>
      </ul>
    </article>
  );
}
