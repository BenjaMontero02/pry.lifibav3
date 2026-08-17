const NUMBER_FORMATTER = new Intl.NumberFormat("es-AR");

export default function IndexSummary({ summary }) {
  const current = summary || {};
  const errorTotal = Number(current.errorPhotos || 0) + Number(current.unreadablePhotos || 0);

  const items = [
    {
      key: "indexed",
      value: Number(current.indexedPhotos || 0),
      label: "Listas",
      tone: "ok"
    },
    {
      key: "pending",
      value: Number(current.pendingPhotos || 0),
      label: "Pendientes",
      tone: "warn"
    },
    {
      key: "no_faces",
      value: Number(current.photosWithoutFaces || 0),
      label: "Sin rostro",
      tone: "muted"
    },
    {
      key: "faces_filtered",
      value: Number(current.statusCounts?.faces_filtered || 0),
      label: "Rostro no valido",
      tone: "muted",
      title: "Se detecto un rostro pero no cumple con los criterios de calidad"
    },
    {
      key: "error",
      value: errorTotal,
      label: "Con error",
      tone: "error"
    }
  ];

  return (
    <ul className="index-summary" aria-label="Resumen del catalogo">
      {items.map((item) => (
        <li
          key={item.key}
          className={`index-summary-item${item.value > 0 ? ` index-summary-item-${item.tone}` : ""}`}
          title={item.title}
        >
          <span className="index-summary-value">{NUMBER_FORMATTER.format(item.value)}</span>
          <span className="index-summary-label">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
