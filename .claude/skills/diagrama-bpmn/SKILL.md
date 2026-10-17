---
name: diagrama-bpmn
description: Crea, modifica, valida y publica diagramas BPMN 2.0 con el servidor MCP "bpmn" (bpmn-js-mcp) y los muestra en un modelador en línea (modelador web en vivo, página publicada, GitHub Pages o Camunda). Úsala siempre que el usuario pida un diagrama BPMN, un modelo, flujo o mapa de proceso, un flujograma de negocio, pools o carriles, cambiar/validar/exportar un archivo .bpmn, o subir un diagrama a Camunda.
---

# Diagramas BPMN 2.0 con el MCP y el modelador en línea

El objetivo: que el diagrama que pide el usuario termine **dibujado de verdad**
(BPMN 2.0 válido, con coordenadas) y **abierto en un modelador**, no descrito
en texto. Nunca escribas el XML a mano: usa las herramientas `mcp__bpmn__*`.

## 1. Entender el proceso

- Pregunta solo si falta algo que cambia la estructura (quién participa, qué
  decisiones hay). Máximo 1–3 preguntas; si no, asume y di qué asumiste.
- Elige la estructura:
  - Un solo responsable → proceso simple, sin pool.
  - Varios roles de una misma organización → **un pool con carriles**
    (`workflowContext: "single-organization"`).
  - Varias organizaciones o sistemas → **colaboración**: un pool expandido y
    pools colapsados para los externos, unidos con flujos de mensaje.

## 2. Dibujar con el MCP

1. `create_bpmn_diagram` con `name` (y `workflowContext` si hay roles).
   Usa `includeImage: false` mientras construyes para ahorrar contexto.
2. Si hay roles: `create_bpmn_participant` con `name` y `lanes: [{name}, ...]`.
   Copia los `laneIds` y el `participantId` de la respuesta (no los adivines:
   los acentos generan IDs como `Lane_JefeDeRea`).
3. `add_bpmn_elements` con `connect: "chain"` para el camino principal, con
   `participantId` y un `laneId` por elemento. La cadena **se detiene en las
   compuertas**: agrega las ramas con `connect: "none"` y únelas con
   `connect_bpmn_elements` usando `connections` y `label` ("Sí" / "No").
4. `layout_bpmn_diagram` para ordenar de izquierda a derecha.
5. `validate_bpmn_diagram` y corrige todo error y advertencia
   (`.bpmnlintrc` ya desactiva las reglas de Camunda 7 ejecutable y la de
   nombres en inglés).
6. Exporta con `export_bpmn` (rutas relativas a la raíz del proyecto):
   - `format: "xml"`, `filePath: "diagramas/<slug>.bpmn"`
   - `format: "svg"`, `filePath: "diagramas/<slug>.svg"`
   - Revisa el resultado: `format: "png"`, `background: "white"`,
     `filePath: "diagramas/<slug>.png"` y míralo con Read. Si algo se ve mal
     (cruces, etiquetas encimadas), corrige y vuelve a exportar.

`<slug>` = nombre del proceso en minúsculas, sin acentos, con guiones
(`solicitud-de-compra`).

**Convenciones de nombres (en español):**
- Tareas: verbo en infinitivo + objeto → "Revisar solicitud".
- Eventos: objeto + estado → "Solicitud recibida", "Pago realizado".
- Compuertas exclusivas: pregunta → "¿Solicitud aprobada?"; etiqueta cada salida.
- Tipos de tarea: `UserTask` (persona usando un sistema), `ManualTask` (sin
  sistema), `ServiceTask` (automática), `SendTask`/`ReceiveTask` (mensajes).
  Esperas: eventos de temporizador. Excepciones: eventos de borde.
- Camino feliz primero; luego excepciones. Siempre inicio y fin explícitos.

**Modificar un diagrama existente:** `create_bpmn_diagram` con
`filePath: "diagramas/<slug>.bpmn"`, consulta IDs con `list_bpmn_elements`,
edita y exporta al mismo archivo.

**Si las herramientas `mcp__bpmn__*` no están disponibles** (el servidor aún no
se conectó en esta sesión): usa la CLI, que llama al mismo servidor y comparte
sus diagramas:
- `npm run bpmn -- herramientas` / `npm run bpmn -- describir <herramienta>`
- `npm run bpmn -- ejecutar pasos.json` con
  `[{"herramienta": "...", "argumentos": {...}}, ...]`; el texto `{{diagramId}}`
  se reemplaza por el ID del diagrama creado. Pon el archivo de pasos en el
  directorio temporal, no en el repositorio.
- Si falla por dependencias: `npm install`.

## 3. Abrirlo en un modelador

Siempre entrega las rutas `diagramas/<slug>.bpmn` y `.svg`. Después, según
dónde corre la sesión:

**A. En el computador del usuario (sesión local).**
El modelador en vivo muestra el diagrama mientras lo dibujas y al exportarlo.
- ¿Está corriendo? `curl -s localhost:3030/api/estado`
- Si no: ofrece `npm run modelador -- --abrir` (o inícialo en segundo plano si
  el usuario quiere).
- Enlace directo: `http://localhost:3030/?archivo=diagramas/<slug>.bpmn`

**B. En la nube (claude.ai/code, `CLAUDE_CODE_REMOTE=true`).** El usuario no
puede abrir `localhost`. Entonces:
1. Genera la página del modelador con el diagrama incrustado, en la variante
   para Artifact (sin envoltorio `<html>` y con «Copiar BPMN» en lugar de
   descargas, que el visor bloquea):
   `npm run pagina -- diagramas/<slug>.bpmn --artifact --salida <dir-temporal>/<slug>.html`
   (usa tu scratchpad si tienes uno).
2. Si tienes la herramienta Artifact, publica ese archivo (icono `diagram`) y
   da el enlace: es un modelador editable en línea, privado hasta que el
   usuario lo comparta. Para actualizar el mismo diagrama, vuelve a generar el
   archivo en la misma ruta y publícalo de nuevo (mismo enlace).
   Sin `--artifact` se obtiene un HTML para abrir con doble clic o enviar por
   correo (queda en `exportados/` si no indicas `--salida`).
3. Haz commit y push del `.bpmn`/`.svg` en la rama de trabajo. Si el repositorio
   tiene GitHub Pages activo, el modelador en línea lo abre con:
   `https://<dueño>.github.io/<repositorio>/?rama=<rama>&archivo=diagramas/<slug>.bpmn`

**C. Camunda (modelador web de Camunda 8 / Camunda Hub).**
- Si hay credenciales (`.env` o variables `CAMUNDA_CONSOLE_CLIENT_ID`,
  `CAMUNDA_CONSOLE_CLIENT_SECRET`, `CAMUNDA_PROJECT_KEY`):
  `npm run camunda -- subir diagramas/<slug>.bpmn` y da el enlace que imprime.
  Si el mismo nombre ya existe en el proyecto, se actualiza.
- Si no hay credenciales, menciona una vez que puede configurarlas
  (ver `.env.example` y el README). En la nube, la red del entorno debe
  permitir `login.cloud.camunda.io` y `hub.cloud.camunda.io`.

**D. Otros modeladores.** El `.bpmn` se abre en Camunda Modeler (escritorio),
demo.bpmn.io (arrastrar y soltar), Bizagi Modeler (Importar ▸ BPMN), Signavio,
etc. Para Bizagi, recomienda probar primero con un diagrama sencillo.

## 4. Responder

Breve: qué se modeló (pools/carriles, pasos, decisiones), supuestos, resultado
de la validación y los enlaces/rutas para abrirlo.
