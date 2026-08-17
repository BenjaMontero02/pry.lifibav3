## Why

El operador no encuentra cómo mandar a indexar las fotos de la carpeta. La accion existe (`index_photos`) pero esta escondida detras de un boton rotulado "Actualizar fotos" en la vista Fotos, que se lee como "refrescar la lista". Ademas el resumen del indice (`IndexSummary`) se importa y se recibe por props en `PhotosView` pero nunca se renderiza, asi que el operador tampoco ve cuantas fotos quedan pendientes: el boton no tiene un "para que" visible.

## What Changes

- Nuevo panel de indexado explicito en la vista Fotos, ubicado arriba del listado, que agrupa estado + acciones del catalogo facial.
- El panel muestra el resumen del indice (Listas / Pendientes / Sin rostro / Rostro no valido / Con error) renderizando el componente `IndexSummary` que hoy esta muerto.
- Accion primaria **"Indexar fotos"** con el conteo de pendientes en la etiqueta (ej. "Indexar 128 pendientes"). Reemplaza el uso actual de "Actualizar fotos" como disparador del analisis facial.
- Accion secundaria **"Reindexar todo"**, que envia `forceReindex: true` a `index_photos`. Requiere confirmacion. Hoy no existe forma de forzar un reindexado completo salvo limpiar el catalogo primero.
- Se separa explicitamente **recargar la lista** (relee la carpeta, sin invocar Python) de **indexar** (analisis facial). El boton de recarga deja de ser ambiguo.
- "Limpiar catalogo" se mantiene como accion destructiva, agrupada en el mismo panel.
- Durante el indexado, la barra de progreso y el estado viven dentro del panel, no sueltos en la vista.

**No incluye**: cambios en el motor de indexado Python, ni el CTA de "indexar ahora" al guardar la carpeta en Ajustes (opcion C descartada para este alcance).

## Capabilities

### New Capabilities
- `photo-indexing`: control operativo del indexado facial de la carpeta del evento desde la ventana de operador - visibilidad del estado del catalogo, disparo del indexado incremental, reindexado forzado y limpieza.

### Modified Capabilities
<!-- Ninguna: el proyecto todavia no tiene specs bajo openspec/specs/. -->

## Impact

- `src/windows/operator/views/PhotosView.jsx` - nuevo panel, reorganizacion de la toolbar, render de `IndexSummary`.
- `src/windows/operator/hooks/usePhotos.js` - separar `handleUpdatePhotos` (indexar) de una recarga de lista pura; nuevo handler de reindexado forzado.
- `src/windows/operator/App.jsx` - cableado de los nuevos handlers/props.
- `src/shared/index.css` - estilos del panel.
- **Sin cambios en Electron ni Python**: `main.js:1539` ya reenvia `data` sin filtrar hacia `index_photos`, por lo que `forceReindex` llega a `index_photos.py:271` tal cual. `pendingPhotos` e `indexedPhotos` ya viajan en `indexSummary` desde `config:list-source-photos`.
