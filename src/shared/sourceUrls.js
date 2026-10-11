// URLs de los protocolos custom que registra electron/main.js.
// sourcephoto: foto completa. sourcethumb: miniatura (para grillas).

export function buildSourcePhotoUrl(filePath) {
  return `sourcephoto://${encodeURIComponent(filePath)}`;
}

export function buildSourceThumbUrl(filePath) {
  return `sourcethumb://${encodeURIComponent(filePath)}`;
}
