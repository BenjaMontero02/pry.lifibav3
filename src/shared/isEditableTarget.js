/**
 * Indica si el foco esta en un control donde una tecla no debe disparar atajos
 * globales (campos de texto, selects). Los botones solo se ignoran si el caller
 * lo pide: en el jugador, las flechas tienen que seguir andando despues de clickear
 * una foto de la grilla (que es un boton con foco).
 */
export default function isEditableTarget(target, { includeButtons = false } = {}) {
  if (!target || typeof target !== "object") {
    return false;
  }
  const tagName = target.tagName;
  if (target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return includeButtons && tagName === "BUTTON";
}
