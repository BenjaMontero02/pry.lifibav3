/**
 * Copia texto al portapapeles y devuelve si lo logro.
 *
 * En el build empaquetado la ventana se carga con `loadFile` (file://), que no
 * es un contexto seguro: ahi `navigator.clipboard` no existe. Por eso el
 * fallback con textarea + execCommand, que si funciona sobre file://.
 */
export default async function copyText(text) {
  const value = String(text ?? "");
  if (!value) {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Sigue con el fallback.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
