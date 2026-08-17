## 1. Hook: separar indexar de recargar

- [x] 1.1 En `usePhotos.js`, renombrar `handleUpdatePhotos` a `handleIndexPhotos` y aceptar un parametro `{ force = false }` que se envie como `forceReindex` en el payload de `sendToPython("index_photos", ...)`.
- [x] 1.2 Agregar `handleReindexAll` que pida confirmacion (`window.confirm`) advirtiendo que se reprocesan todas las fotos, y delegue en `handleIndexPhotos({ force: true })`.
- [x] 1.3 Agregar `handleReloadPhotos` que solo llame a `loadPhotos({ refresh: true, statusFilter: photosStatusFilter })`, sin invocar Python.
- [x] 1.4 Exponer en el retorno del hook: `handleIndexPhotos`, `handleReindexAll`, `handleReloadPhotos`, y mantener `currentIndexSummary`, `clearingIndex`, `indexingPhotos`, `indexingMessage`, `indexingProgressPercent`, `indexingProgressLabel`.
- [x] 1.5 Verificar que `currentIndexSummary.pendingPhotos` refleje las fotos pendientes reales tras cada corrida y tras `index:clear`. Confirmado: `main.js:1024` calcula `pendingPhotos = totalPhotos - tracked` sobre el total de la carpeta (no sobre la vista filtrada), y `clearFaceIndex` (`main.js:1323`) borra las filas de `photo_index_status`, dejando `tracked = 0`.

## 2. UI: panel de indexado en PhotosView

- [x] 2.1 Crear el bloque `<section className="index-panel">` en `PhotosView.jsx`, ubicado entre la intro y la toolbar de busqueda, por encima del listado.
- [x] 2.2 Renderizar `IndexSummary` dentro del panel usando `currentIndexSummary` (hoy el import esta sin uso).
- [x] 2.3 Agregar la accion primaria "Indexar fotos" con etiqueta dinamica segun pendientes (ej. `Indexar 128 pendientes`; sin pendientes, deshabilitada con leyenda "Todo indexado").
- [x] 2.4 Agregar la accion secundaria "Reindexar todo" cableada a `onReindexAll`.
- [x] 2.5 Mover el boton "Limpiar catalogo" desde la toolbar al panel, conservando su confirmacion actual.
- [x] 2.6 Reemplazar el boton "Actualizar fotos" de la toolbar por "Recargar lista", cableado a `onReloadPhotos`.
- [x] 2.7 Mover el bloque `index-progress` y el `indexingMessage` al interior del panel.
- [x] 2.8 Deshabilitar indexar / reindexar / limpiar mientras `indexingPhotos || clearingIndex || photosLoading`, y cuando no hay `photosPath`.
- [x] 2.9 Mostrar el estado "No hay carpeta configurada" dentro del panel cuando `photosPath` este vacio.

## 3. Cableado y estilos

- [x] 3.1 Actualizar `App.jsx` para pasar los nuevos handlers como props (`onIndexPhotos`, `onReindexAll`, `onReloadPhotos`) y quitar `onUpdatePhotos`.
- [x] 3.2 Agregar estilos de `.index-panel` en `src/shared/index.css`, coherentes con `.sourcepad-runtime` y `.index-summary` existentes. Ademas se corrigio `.index-summary` de 4 a 5 columnas: tiene 5 items y la quinta tarjeta se desbordaba a una segunda fila.
- [x] 3.3 Actualizar el texto de la vista Inicio (`OverviewView.jsx`) para mencionar que el indexado se dispara desde Fotos.

## 4. Reorganizacion del alto de la vista (feedback de operador en monitor 24")

- [x] 4.1 Contadores del catalogo pasan de 5 tarjetas grandes a chips inline en el header del panel (`IndexSummary.jsx` reescrito como lista de pills).
- [x] 4.2 Eliminar el parrafo `intro` de la vista y compactar el encabezado: `h1` a 1.4rem y el conteo de fotos al lado del titulo.
- [x] 4.3 Fusionar la toolbar y el buscador en una sola fila; el buscador se alinea a la derecha.
- [x] 4.4 Quitar `photos-filter-note` (redundante con el conteo del encabezado y los contadores de cada filtro).
- [x] 4.5 Convertir el bloque Carpeta/Miniaturas en un `<details>` plegable, cerrado por defecto, con dos chips de estado en la linea resumen.
- [x] 4.6 Mover la barra de progreso a la misma fila de las acciones, para no sumar alto durante el indexado.
- [x] 4.7 Reducir el padding de `.operator-card-photos` y corregir la contradiccion entre el chip "Indexando" y el texto "Todas las fotos ya fueron analizadas": el hint solo aparece cuando no hay carpeta o la carpeta esta vacia.

## 5. Verificacion

- [ ] 5.1 Con carpeta configurada y fotos nuevas: el panel muestra pendientes > 0 y "Indexar N pendientes" ejecuta el analisis incremental.
- [ ] 5.2 Tras indexar, pendientes queda en 0 y el boton de indexar se deshabilita.
- [ ] 5.3 "Reindexar todo" confirmado reprocesa fotos ya listas (verificar `rebuildReason: "force_reindex"` en la respuesta de Python).
- [ ] 5.4 "Reindexar todo" cancelado no dispara ninguna llamada a Python.
- [ ] 5.5 "Recargar lista" refresca el listado sin invocar `index_photos`.
- [ ] 5.6 Sin carpeta configurada: las tres acciones del panel estan deshabilitadas.
- [ ] 5.7 Durante el indexado la barra de progreso avanza dentro del panel y las acciones estan bloqueadas.
- [ ] 5.8 La lista de fotos ocupa el alto sobrante en un monitor de 24" (al menos ~6 filas visibles sin scrollear la tarjeta).
