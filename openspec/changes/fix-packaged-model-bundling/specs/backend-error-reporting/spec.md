## Purpose

Garantiza que cualquier fallo del proceso Python llegue visible al operador de la app, con detalle suficiente para diagnosticar sin abrir una terminal, y que ningun fallo pueda presentarse como una operacion exitosa.

## ADDED Requirements

### Requirement: Ningun error del backend puede tener mensaje vacio

Toda respuesta de error del proceso Python SHALL incluir un mensaje no vacio. Cuando la excepcion original no aporte texto, la respuesta SHALL incluir el tipo de la excepcion como mensaje.

#### Scenario: Excepcion sin texto

- **WHEN** el backend falla con una excepcion cuyo texto es vacio
- **THEN** la respuesta de error igual llega con un mensaje no vacio que identifica el tipo de fallo

#### Scenario: Excepcion con texto

- **WHEN** el backend falla con una excepcion que tiene texto
- **THEN** la respuesta de error preserva ese texto

### Requirement: Un fallo del backend nunca se reporta como exito

El puente entre la app y el proceso Python SHALL decidir si una respuesta es exitosa a partir de su indicador explicito de exito, y NO a partir de si el mensaje de error esta presente o no vacio. Una respuesta marcada como fallida SHALL rechazarse siempre.

#### Scenario: Respuesta fallida con mensaje vacio

- **WHEN** el backend devuelve una respuesta marcada como fallida y su mensaje de error es vacio
- **THEN** la operacion se trata como fallida
- **AND** la app recibe un error con un mensaje sustituto que indica el fallo y la accion involucrada

#### Scenario: Respuesta fallida con mensaje

- **WHEN** el backend devuelve una respuesta marcada como fallida con un mensaje
- **THEN** la operacion se trata como fallida con ese mensaje

### Requirement: La indexacion solo se declara completa cuando termino

La vista de fotos SHALL declarar la indexacion completa unicamente cuando el backend devuelva el resultado de la corrida. Una respuesta sin resultado SHALL presentarse al operador como fallo, no como exito.

#### Scenario: Respuesta sin resultado de la corrida

- **WHEN** la accion de indexar termina sin que el backend haya devuelto el resultado de la corrida
- **THEN** la vista muestra un error de indexacion
- **AND** no muestra ningun mensaje de analisis completo

#### Scenario: Corrida completada

- **WHEN** la accion de indexar termina con el resultado de la corrida
- **THEN** la vista muestra el resumen de fotos revisadas y rostros encontrados

### Requirement: El error visible incluye el detalle de diagnostico

Cuando la indexacion falle, el mensaje mostrado al operador SHALL incluir el detalle tecnico del fallo reportado por el backend, sin exigir acceso a una consola o a los logs del proceso.

#### Scenario: Fallo de carga de modelos al indexar

- **WHEN** la indexacion falla porque el backend no pudo cargar los modelos faciales
- **THEN** el operador ve un mensaje de error en la vista de fotos
- **AND** el mensaje contiene el detalle del fallo reportado por el backend
