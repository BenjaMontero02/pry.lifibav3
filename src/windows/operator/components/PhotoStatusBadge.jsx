const PHOTO_STATUS_LABELS = {
  indexed: "Indexada",
  no_faces: "Sin cara",
  unreadable: "Ilegible",
  error: "Error",
  pending: "Pendiente",
  unknown: "Sin estado"
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
  if (status === "no_faces") {
    return "photo-status photo-status-muted";
  }
  return "photo-status";
}

export default function PhotoStatusBadge({ status, lastError = "" }) {
  return (
    <p className={getPhotoStatusClassName(status)} title={lastError}>
      {getPhotoStatusLabel(status)}
    </p>
  );
}
