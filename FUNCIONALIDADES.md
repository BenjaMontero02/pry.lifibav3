# Funcionalidades del Sistema — App Fotos Evento Deportivo

---

## Python Service (`python/main.py`)

Corre como proceso hijo de Electron. Se comunica via stdin/stdout con JSON.
Recibe `{ "action": "...", "data": {} }` y responde `{ "ok": true, "result": {} }`.

---

### 1. Indexado de Fotos (`action: index_photos`)

- Recibe la ruta de la carpeta de fotos del evento
- Itera sobre todas las imágenes de la carpeta
- Por cada foto detecta **todas las caras** presentes usando InsightFace (RetinaFace)
- Genera un **embedding facial** por cada cara detectada (modelo Buffalo_L / ArcFace)
- Guarda los embeddings en un índice **FAISS** en disco
- Asocia cada embedding con la ruta de la foto de origen
- Reporta progreso mientras indexa (cantidad de fotos procesadas / total)
- Maneja fotos sin caras detectadas sin romper el proceso
- Soporta reinicio de indexado si se agregan fotos nuevas a la carpeta

---

### 2. Reconocimiento Facial (`action: find_player`)

- Recibe un frame capturado desde la webcam (celu via DroidCam/Camo)
- Detecta la cara del jugador en el frame usando InsightFace
- Genera el embedding de esa cara
- Busca en el índice FAISS las fotos más similares usando distancia coseno
- Devuelve la lista de rutas de fotos donde aparece el jugador, ordenadas por similitud
- Maneja el caso de que no se detecte ninguna cara en el frame
- Maneja el caso de que no se encuentren coincidencias por encima del umbral mínimo

---

### 3. Captura de Webcam (`action: capture_frame`)

- Accede a la webcam virtual expuesta por DroidCam/Camo en Windows
- Captura un frame en el momento solicitado
- Devuelve la imagen como base64 para previsualización en la UI
- Maneja el caso de que la cámara no esté disponible o desconectada

---

### 4. Procesamiento de Imagen para Impresión (`action: process_image`)

- Recibe la ruta de la foto seleccionada
- Redimensiona la imagen al tamaño de papel configurado (A4 a 300 DPI)
- Aplica corrección básica de color y contraste si es necesario
- Opcionalmente agrega overlay con logo del evento
- Guarda una imagen temporal lista para imprimir

---

### 5. Impresión (`action: print_photo`)

- Recibe la ruta de la imagen procesada
- Envía la imagen a la impresora **Epson L395** usando los drivers de Windows (`win32api` / `win32print`)
- Confirma que la orden fue enviada correctamente
- Maneja errores de impresora no disponible o sin papel

---

### 6. Limpieza del Índice (`action: clear_index`)

- Borra el índice FAISS del disco
- Borra los embeddings guardados
- Usado al finalizar el evento para no retener datos biométricos

---

## Node.js — Electron Main Process (`electron/main.js` y módulos)

Orquesta toda la aplicación. Gestiona las ventanas, la base de datos local, la carpeta de fotos y la comunicación con el Python service.

---

### 1. Gestión de Ventanas

- Abre **dos BrowserWindow** al iniciar, una por monitor
- Ventana 1 (operador): panel de control, visor de cámara, estado del sistema
- Ventana 2 (jugador): galería de fotos para selección
- Mantiene ambas ventanas sincronizadas via IPC

---

### 2. Ciclo de Vida del Python Service

- Al arrancar la app, levanta `face-print.exe` como proceso hijo con `child_process`
- Mantiene el proceso vivo durante toda la sesión
- Mata el proceso al cerrar la app
- Maneja crashes del proceso Python y lo reinicia automáticamente

---

### 3. Gestión de la Carpeta de Fotos

- Permite configurar la ruta de la carpeta de fotos del evento
- Escanea la carpeta y lista todas las imágenes disponibles
- Observa la carpeta con un file watcher para detectar fotos nuevas agregadas
- Al detectar fotos nuevas notifica al usuario para re-indexar
- Sirve las imágenes locales al frontend via protocolo personalizado de Electron (`app://`)

---

### 4. Base de Datos Local (SQLite)

Usando `better-sqlite3` directamente en el main process.

Tablas:

- **eventos**: nombre del evento, fecha, ruta de carpeta de fotos, estado del índice
- **impresiones**: registro de cada impresión realizada (foto, timestamp, estado)
- **configuracion**: impresora seleccionada, ruta de carpeta, ajustes generales

---

### 5. Comunicación con Python Service (python-bridge.js)

- Función genérica `sendToPython(action, data)` que devuelve una Promise
- Serializa el mensaje como JSON y lo escribe en stdin del proceso Python
- Escucha stdout y parsea la respuesta JSON
- Maneja timeouts si Python no responde en un tiempo razonable
- Cola de mensajes para evitar condiciones de carrera

---

### 6. IPC con el Frontend (React)

Handlers registrados en `ipcMain`:

| Canal | Descripción |
|---|---|
| `index:start` | Dispara el indexado de fotos en Python |
| `index:status` | Devuelve el estado actual del indexado |
| `player:scan` | Captura frame y busca al jugador en las fotos |
| `photos:list` | Devuelve las fotos encontradas para un jugador |
| `print:send` | Manda las fotos seleccionadas a imprimir |
| `config:get` | Lee la configuración guardada |
| `config:set` | Guarda configuración |
| `folder:select` | Abre el diálogo nativo para elegir carpeta de fotos |
| `prints:history` | Devuelve el historial de impresiones del evento |

---

## Consideraciones Generales

- **Sin internet**: Todo corre local, sin dependencias externas en tiempo de ejecución
- **Datos biométricos**: Los embeddings faciales se borran al finalizar el evento (`clear_index`)
- **Empaquetado**: Python service compilado con PyInstaller, Electron empaquetado con electron-builder + NSIS
- **Tamaño estimado del instalador**: ~1.2 GB incluyendo modelos de InsightFace
