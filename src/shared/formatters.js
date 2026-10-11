const NUMBER_FORMATTER = new Intl.NumberFormat("es-AR");
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "medium"
});

export function formatCount(value) {
  return NUMBER_FORMATTER.format(Number(value || 0));
}

export function formatDateTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Sin datos";
  }
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}
