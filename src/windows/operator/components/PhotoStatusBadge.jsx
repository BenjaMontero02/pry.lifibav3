const PHOTO_STATUS_LABELS = {
  indexed: "Indexada",
  no_faces: "Sin cara",
  faces_filtered: "Cara descartada",
  unreadable: "Ilegible",
  error: "Error",
  pending: "Pendiente",
  unknown: "Sin estado"
};

const PHOTO_STATUS_TITLES = {
  faces_filtered: "Se detectaron caras pero se descartaron por tamano o confianza insuficiente"
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
