# Runbook operativo

Este runbook cubre el smoke real de desarrollo y el troubleshooting local de
LifibaV3. Ejecutar los comandos desde la raiz del repo:
`C:\Users\monte\OneDrive\Escritorio\traspaso\pry.lifibav3`.

## Comandos base

```powershell
pnpm.cmd run smoke:dev
pnpm.cmd run smoke:ipc
pnpm.cmd run check
pnpm.cmd run dev
```

- `pnpm.cmd run smoke:dev`: diagnostico liviano. No levanta Vite ni Electron.
  Verifica `ELECTRON_RUN_AS_NODE`, instalacion/binario de Electron, puerto
  `127.0.0.1:5173`, Python (`.venv` o `python` en `PATH`) y scripts de dev.
- `pnpm.cmd run smoke:ipc`: smoke estatico de IPC. Primero ejecuta
  `smoke:dev`; despues valida allowlist de preload y handlers de main para
  `config:get-source-path`, `index:get-status` y `player:get-preview-photos`.
  `config:list-source-photos` es opcional porque requiere sourcepad valido.
  Este smoke no invoca Electron vivo, camara ni acciones Python.
- `pnpm.cmd run check`: validacion antes de handoff. Corre sintaxis Electron,
  compilacion Python y build del renderer.
- `pnpm.cmd run dev`: levanta Vite en `127.0.0.1:5173` y luego Electron. El
  script de Electron espera ese puerto y limpia `ELECTRON_RUN_AS_NODE` para el
  proceso hijo.

## Smoke real

1. Ejecutar `pnpm.cmd run smoke:dev`.
   - Corregir cualquier `FAIL`.
   - Un `WARN` de puerto `5173` ocupado es esperable solo si Vite ya esta
     levantado para una corrida parcial. Si no, tratarlo como proceso stale.

2. Ejecutar `pnpm.cmd run smoke:ipc`.
   - Debe pasar el precheck de `smoke:dev`.
   - Los canales requeridos de preload/main deben figurar como `OK`.

3. Ejecutar `pnpm.cmd run check`.
   - Usarlo como gate local antes de entregar cambios o validar una rama.

4. Levantar la app con `pnpm.cmd run dev`.
   - Abrir la ventana de operador en Electron, no el HTML directo en navegador,
     para validar IPC real.

5. Configurar un sourcepad valido.
   - Ir a `Configuracion de Sourcepad`.
   - Usar `Elegir carpeta` o escribir una ruta local existente.
   - Presionar `Guardar en base de datos`.
   - Debe quedar como `Configuracion sincronizada` y mostrar estado exitoso.
   - Sourcepad valido significa: carpeta existente, accesible por el usuario de
     Windows y con fotos soportadas (`.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`,
     `.webp`, `.tif`, `.tiff`, `.heic`, `.heif`) si se quiere completar el
     smoke visual.

6. Validar `Diagnostico`.
   - Entrar a `Diagnostico` y usar `Refrescar diagnostico`.
   - Esperado sano:
     - `Electron IPC respondio.`
     - `Sourcepad valido con N fotos detectadas.`
     - `Smoke OK: sourcepad respondio...`
     - Watch sourcepad disponible o activo.
     - Directorio de indice visible si hay sourcepad.
   - Si aparece `Reescanear sourcepad`, ejecutarlo cuando el conteo este stale
     o despues de agregar/quitar fotos.

7. Validar `Fotos` y `Actualizar fotos`.
   - Entrar a `Fotos`.
   - Confirmar que lista la carpeta origen y muestra conteos.
   - Presionar `Actualizar fotos` para ejecutar `index_photos`.
   - Esperado sano:
     - Progreso `processed/total`.
     - Mensaje final de indexacion completa.
     - Conteos de indexadas, pendientes, sin cara y con error actualizados.
   - `Limpiar indice` borra el indice facial local y obliga a reindexar con
     `Actualizar fotos`; no borra las fotos originales.

8. Validar `Escanear jugador`.
   - Primero debe existir indice facial generado desde `Fotos`/`Actualizar
     fotos`.
   - Ir a `Escanear jugador`.
   - Seleccionar camara si hay mas de una.
   - Presionar `Prender camara`.
   - Cuando el video este listo, usar `Capturar y buscar`.
   - Esperado sano:
     - Resultados ordenados por similitud, o un mensaje explicito de sin cara /
       sin coincidencias.
     - Al seleccionar coincidencias y presionar `Previsualizacion`, `Diagnostico`
       debe mostrar la ultima preview enviada al reproductor.

## Watcher y prewarm

- Al guardar un sourcepad se inicia el watcher sobre esa carpeta.
- `sourcepad:get-watch-status` alimenta el bloque `Smoke sourcepad` en
  `Diagnostico`.
- Cambios detectados en archivos disparan `sourcepad:changed`, limpian cache de
  listado y programan rescan con debounce.
- `sourcepad:rescan` fuerza refresco, recalcula resumen y reinicia prewarm.
- `config:list-source-photos` lista fotos y encola prewarm de thumbnails para
  las fotos devueltas.
- Errores de watcher aparecen como `sourcepad:watch-error` en `Fotos` y como
  detalle en `Diagnostico`.

## Packaging Windows

- `electron-builder.yml` empaqueta con ASAR, desempaqueta modulos nativos de
  `better-sqlite3`, incluye `resources/python` como recurso externo y usa icono
  Windows desde `resources/build/icon.ico`.
- Smoke sin instalador, util para validar estructura y dependencias nativas:

```powershell
pnpm.cmd exec electron-builder --config electron-builder.yml --dir --publish never --config.win.signAndEditExecutable=false
```

- Build completo/instalador:

```powershell
pnpm.cmd run build
```

- Si aparece `Cannot create symbolic link` al extraer `winCodeSign`, es un
  bloqueo de privilegios de Windows para symlinks en el cache de
  electron-builder. Activar Developer Mode o correr una terminal elevada y
  reintentar el build completo. El smoke anterior omite la edicion/firma del
  exe, por lo que valida empaquetado base pero no valida icono embebido,
  shortcuts ni NSIS.

## Datos persistidos

- SQLite: `app.getPath("userData")\app.sqlite`.
  - Guarda la configuracion de sourcepad con key `add source`.
  - Guarda estado del indice por sourcepad y preview enviada al reproductor.
  - Puede tener sidecars WAL/SHM cuando la app esta abierta.
- Indice facial: `app.getPath("userData")\face-index`.
  - `faces.faiss`: indice FAISS.
  - `vectors.json`: mapping de vectores a fotos.
  - `photos_manifest.json`: estado por foto, firmas, errores y conteos.
- En build instalado, `userData` queda bajo el perfil de la app `LifibaV3`.
  En desarrollo puede depender del nombre Electron usado por el runtime. La ruta
  exacta del indice tambien se ve en `Diagnostico`.

## Troubleshooting

| Sintoma | Causa probable | Accion |
| --- | --- | --- |
| `ELECTRON_RUN_AS_NODE is set` en `smoke:dev` | La shell fuerza Electron a comportarse como Node | Ejecutar `Remove-Item Env:ELECTRON_RUN_AS_NODE` en esa PowerShell y reintentar. |
| Puerto `5173` ocupado | Vite ya esta corriendo o quedo un proceso stale | Si es una corrida parcial, seguir. Si no, inspeccionar con `netstat -ano | findstr :5173` y cerrar el PID stale antes de `pnpm.cmd run dev`. |
| Electron no encuentra binario | Postinstall incompleto | Probar `node node_modules/electron/install.js`; si no alcanza, `pnpm.cmd install --force`. |
| `.venv` ausente o Python falla | Entorno Python no preparado | Ejecutar `python -m venv .venv` y despues `.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt`. |
| Renderer muestra fallback o IPC no responde | Se abrio en navegador o preload no cargo | Validar desde Electron levantado con `pnpm.cmd run dev`, no desde `http://localhost:5173` en navegador. |
| `No hay carpeta sourcepad configurada` | No se guardo sourcepad | Ir a `Configuracion de Sourcepad`, elegir carpeta y guardar. |
| `La ruta sourcepad guardada no existe o no es valida` | Carpeta movida, borrada o inaccesible | Guardar una ruta existente. Evitar editar `app.sqlite` salvo recuperacion manual controlada. |
| `Fotos` no actualiza conteos | Cache/listado stale o watcher con error | Usar `Diagnostico` -> `Reescanear sourcepad`; si persiste, revisar permisos/ruta y errores de watcher. |
| `index_photos` dice indice vacio o no aparecen resultados | No se corrio `Actualizar fotos` o no hay caras detectables | Ejecutar `Fotos` -> `Actualizar fotos`; revisar conteos `Sin cara`, `Con error` y `Pendientes`. |
| `FAISS index and vectors.json are out of sync` | Artefactos de `face-index` inconsistentes | Usar `Limpiar indice` y luego `Actualizar fotos`. |
| `Escanear jugador` devuelve `empty_index` | Falta `face-index` usable | Completar `Fotos` -> `Actualizar fotos`. |
| `Escanear jugador` devuelve `no_face_detected` | Frame sin rostro util o camara mal encuadrada | Reencuadrar, mejorar luz, elegir camara correcta y repetir captura. |
| `Escanear jugador` no encuentra coincidencias | Umbral alto o jugador no indexado | Bajar el umbral, verificar que el jugador este en sourcepad y reindexar si se agregaron fotos. |

## Criterio de cierre

El smoke real queda aceptado cuando:

- `pnpm.cmd run smoke:dev`, `pnpm.cmd run smoke:ipc` y `pnpm.cmd run check`
  terminan sin `FAIL`.
- `pnpm.cmd run dev` abre Electron con IPC real.
- `Diagnostico` informa IPC OK, sourcepad valido, smoke sourcepad OK y sin
  errores bloqueantes.
- `Fotos` lista sourcepad y `Actualizar fotos` completa indexacion.
- `Escanear jugador` puede capturar desde camara y devuelve resultados o un
  estado esperado y explicito.
