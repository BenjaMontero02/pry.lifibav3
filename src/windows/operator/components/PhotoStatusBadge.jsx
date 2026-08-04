const PHOTO_STATUS_LABELS = {
  indexed: "Lista",
  no_faces: "Sin rostro",
  faces_filtered: "Rostro no valido",
  unreadable: "No se puede leer",
  error: "Error",
  pending: "Pendiente",
  unknown: "Sin estado"
};

const PHOTO_STATUS_TITLES = {
  faces_filtered: "Se detecto un rostro pero no cumple con los criterios de calidad",
  no_faces: "No se encontro ningun rostro en esta foto",
  unreadable: "No se pudo abrir el archivo de imagen",
  error: "Ocurrio un error al procesar esta foto",
  pending: "Esta foto aun no fue procesada"
};

function getPhotoStatusLabel(status) {
  return PHOTO_STATUS_LABELS[status] || PHOTO_STATUS_LABELS.unknown;
}

function getPhotoStatusClassName(status) {
  if (status === "indexed") {
    return "photo-status photo-status-indexed";
  }
  if (status === "error" || status === "unreadable") {
    return "photo-status photo-status-error";
  }
  if (status === "no_faces" || status === "faces_filtered") {
    return "photo-status photo-status-muted";
  }
  return "photo-status";
}

export default function PhotoStatusBadge({ status, lastError = "" }) {
  return (
    <p className={getPhotoStatusClassName(status)} title={lastError || PHOTO_STATUS_TITLES[status] || ""}>
      {getPhotoStatusLabel(status)}
    </p>
  );
}
