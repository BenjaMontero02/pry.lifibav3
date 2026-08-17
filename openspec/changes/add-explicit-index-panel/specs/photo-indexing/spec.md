## Purpose

Le da al operador control visible sobre el indexado facial de la carpeta del evento: ver en que estado esta el catalogo, disparar el analisis de las fotos pendientes, forzar un reindexado completo y limpiar los datos biometricos al terminar.

## ADDED Requirements

### Requirement: Panel de indexado visible en la vista Fotos

La ventana de operador SHALL mostrar, en la vista Fotos y por encima del listado, un panel dedicado al indexado que agrupe el estado del catalogo y todas las acciones que lo modifican.

#### Scenario: El operador entra a la vista Fotos con una carpeta configurada

- **WHEN** el operador abre la vista Fotos y hay una carpeta del evento configurada
- **THEN** el panel de indexado se muestra por encima del listado de fotos
- **AND** presenta el estado del catalogo y las acciones de indexar, reindexar y limpiar

#### Scenario: No hay carpeta configurada

- **WHEN** el operador abre la vista Fotos sin carpeta del evento configurada
- **THEN** el panel indica que no hay carpeta configurada
- **AND** las acciones de indexar, reindexar y limpiar quedan deshabilitadas

### Requirement: Resumen del estado del catalogo

El panel SHALL mostrar el conteo de fotos por estado del catalogo: listas (indexadas), pendientes, sin rostro, rostro no valido y con error.

#### Scenario: Carpeta con fotos en distintos estados

- **WHEN** el catalogo tiene fotos indexadas, pendientes, sin rostro, con rostro descartado por calidad y con error
- **THEN** el panel muestra un conteo por cada uno de esos cinco estados

#### Scenario: El resumen se actualiza al terminar el indexado

- **WHEN** una corrida de indexado finaliza
- **THEN** los conteos del panel reflejan el estado resultante sin requerir accion adicional del operador

### Requirement: Accion explicita de indexar fotos pendientes

El panel SHALL ofrecer una accion primaria rotulada de forma inequivoca como indexado (no como "actualizar"), que dispare el analisis facial de las fotos nuevas o modificadas de la carpeta configurada.

#### Scenario: Hay fotos pendientes

- **WHEN** el catalogo tiene N fotos pendientes y el operador activa la accion de indexar
- **THEN** la etiqueta de la accion comunica la cantidad pendiente antes de activarla
- **AND** el sistema procesa las fotos nuevas o modificadas y deja intactas las ya indexadas sin cambios

#### Scenario: No hay fotos pendientes

- **WHEN** el catalogo no tiene fotos pendientes
- **THEN** la accion de indexar comunica que no hay trabajo pendiente
- **AND** el operador conserva la posibilidad de forzar un reindexado completo

#### Scenario: El indexado falla

- **WHEN** el proceso de indexado devuelve un error
- **THEN** el panel muestra el mensaje de error
- **AND** las acciones vuelven a quedar habilitadas para reintentar

### Requirement: Reindexado completo forzado

El panel SHALL ofrecer una accion secundaria de reindexado completo que reprocese todas las fotos de la carpeta, ignorando el estado previo del catalogo, y SHALL pedir confirmacion explicita antes de ejecutarla.

#### Scenario: El operador confirma el reindexado

- **WHEN** el operador activa el reindexado completo y confirma la advertencia
- **THEN** todas las fotos de la carpeta se reprocesan, incluidas las que figuraban como listas

#### Scenario: El operador cancela el reindexado

- **WHEN** el operador activa el reindexado completo y cancela la confirmacion
- **THEN** no se dispara ningun procesamiento y el catalogo queda sin cambios

### Requirement: Progreso visible durante el indexado

Mientras una corrida de indexado esta en curso, el sistema SHALL mostrar el progreso dentro del panel y SHALL impedir que se dispare otra operacion sobre el catalogo.

#### Scenario: Indexado en curso

- **WHEN** una corrida de indexado esta activa
- **THEN** el panel muestra el avance en fotos procesadas sobre el total
- **AND** las acciones de indexar, reindexar y limpiar quedan deshabilitadas hasta que termine

#### Scenario: Indexado terminado

- **WHEN** la corrida finaliza correctamente
- **THEN** el panel muestra un resumen del resultado con fotos revisadas y rostros encontrados

### Requirement: Recarga de la lista separada del indexado

La vista Fotos SHALL exponer la recarga del listado como una accion distinta e independiente del indexado, y esa recarga NO SHALL disparar analisis facial.

#### Scenario: El operador recarga la lista

- **WHEN** el operador activa la recarga del listado
- **THEN** el sistema vuelve a leer la carpeta y refresca el listado y los conteos
- **AND** no se ejecuta ningun analisis facial

### Requirement: Limpieza del catalogo

El panel SHALL ofrecer la accion destructiva de limpiar el catalogo, agrupada junto a las demas acciones de indexado, con confirmacion previa y sin borrar las fotos originales.

#### Scenario: El operador limpia el catalogo

- **WHEN** el operador confirma la limpieza del catalogo
- **THEN** se borran los datos de reconocimiento facial
- **AND** las fotos originales de la carpeta permanecen intactas
- **AND** el panel refleja que todas las fotos vuelven a estado pendiente
