## Purpose

Garantiza que todo instalador publicado de la app contiene los modelos faciales completos y utilizables sin conexion, y que un build al que le falte un modelo se detiene en lugar de producir un instalador que falla en manos del operador.

## ADDED Requirements

### Requirement: Origen fijado y verificable de cada modelo

Cada modelo facial que la app necesita SHALL tener un origen declarado, inmutable y verificable por contenido. La preparacion de modelos SHALL fallar cuando el contenido descargado no coincide con el esperado.

#### Scenario: Descarga con contenido verificado

- **WHEN** se prepara el entorno de build y se descarga un modelo desde su origen declarado
- **THEN** el contenido descargado se verifica contra un valor esperado publicado junto al origen
- **AND** el modelo queda disponible en la ubicacion que el empaquetado espera

#### Scenario: Contenido descargado no coincide

- **WHEN** un modelo se descarga completo pero su contenido no coincide con el valor esperado
- **THEN** la preparacion falla con un mensaje que nombra el modelo y el valor obtenido
- **AND** no se produce ningun instalador

#### Scenario: Origen inaccesible

- **WHEN** el origen de un modelo no responde o devuelve un error
- **THEN** la preparacion falla en ese punto
- **AND** el mensaje distingue "no se pudo descargar" de "se descargo mal"

### Requirement: Estructura de modelos normalizada

La preparacion de modelos SHALL dejar cada modelo en la estructura de directorios que el runtime espera, sin depender de como venga empaquetado el origen. La verificacion de estructura SHALL comprobar la presencia de los archivos de modelo, no unicamente la existencia del directorio contenedor.

#### Scenario: El origen trae los archivos anidados

- **WHEN** un paquete de modelos se distribuye con un nivel de carpeta adicional respecto de lo que el runtime espera
- **THEN** la preparacion aplana la estructura y deja los archivos de modelo en el nivel esperado
- **AND** la verificacion posterior los encuentra

#### Scenario: Directorio presente pero sin archivos de modelo

- **WHEN** el directorio de un pack de modelos existe pero no contiene los archivos de modelo esperados
- **THEN** la verificacion lo trata como faltante
- **AND** la preparacion falla en lugar de continuar

### Requirement: El empaquetado aborta si falta un modelo

El empaquetado del backend SHALL verificar la presencia y estructura de todos los modelos requeridos antes de generar el ejecutable, y SHALL abortar con error cuando alguno falte o este mal estructurado. Un modelo faltante NO SHALL degradarse a advertencia.

#### Scenario: Falta un modelo requerido al empaquetar

- **WHEN** se ejecuta el empaquetado del backend y un modelo requerido falta o esta mal estructurado
- **THEN** el empaquetado termina con error
- **AND** el mensaje identifica el modelo faltante y la ruta donde se lo esperaba
- **AND** no se genera ejecutable ni instalador

#### Scenario: Todos los modelos presentes

- **WHEN** se ejecuta el empaquetado y todos los modelos requeridos estan presentes y bien estructurados
- **THEN** los modelos quedan incluidos dentro del ejecutable empaquetado
- **AND** el backend empaquetado los resuelve sin acceso a la red

### Requirement: El pipeline de build no enmascara fallos de modelos

El pipeline que produce los instaladores SHALL fallar cuando la preparacion o la verificacion de modelos falle. Ningun paso relacionado con modelos SHALL convertir un fallo en advertencia y continuar.

#### Scenario: La preparacion de modelos falla en el pipeline

- **WHEN** el paso de preparacion de modelos falla durante un build automatizado
- **THEN** el build se marca como fallido
- **AND** no se publica ningun artefacto instalable de ese build

### Requirement: Verificacion de extremo a extremo sobre el binario empaquetado

Antes de publicar un instalador, el pipeline SHALL verificar contra el binario del backend **ya empaquetado** que los modelos cargan efectivamente en memoria. La verificacion NO SHALL limitarse a comprobar que el proceso arranca y responde.

#### Scenario: El binario empaquetado carga los modelos

- **WHEN** se ejecuta la verificacion contra el backend empaquetado
- **THEN** la verificacion reporta que el detector de rostros quedo cargado
- **AND** reporta cual backend de embeddings quedo activo
- **AND** exige que sea el backend de embeddings previsto, no un reemplazo degradado

#### Scenario: El bundle arranca pero no tiene modelos

- **WHEN** el backend empaquetado arranca y responde, pero no logra cargar los modelos
- **THEN** la verificacion falla
- **AND** el mensaje incluye el detalle del fallo de carga
- **AND** el build no publica el instalador

### Requirement: Los instaladores funcionan sin conexion

La app instalada SHALL indexar fotos sin descargar modelos en tiempo de ejecucion. El runtime NO SHALL intentar descargar un modelo faltante hacia una ubicacion de solo lectura del propio paquete.

#### Scenario: Primera indexacion en una maquina sin conexion

- **WHEN** el operador instala la app y dispara la indexacion en una maquina sin acceso a internet
- **THEN** la indexacion procede usando los modelos incluidos en el instalador
- **AND** no se intenta ninguna descarga
