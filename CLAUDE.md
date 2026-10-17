# Modelador BPMN 2.0 con Claude Code

Este proyecto conecta Claude Code con un modelador BPMN 2.0 en línea. Cuando el
usuario pida un diagrama de proceso, **usa la skill `diagrama-bpmn`**
(`.claude/skills/diagrama-bpmn/SKILL.md`): dibuja con las herramientas
`mcp__bpmn__*`, valida, exporta a `diagramas/` y ábrelo en un modelador.

- No escribas ni edites XML BPMN a mano: usa el MCP (o `npm run bpmn` si el MCP
  no está conectado).
- Responde y nombra los elementos en español, salvo que el usuario pida otro idioma.

## Piezas

- `.mcp.json` → servidor MCP `bpmn` (`scripts/iniciar-mcp-bpmn.mjs`, que lanza
  [bpmn-js-mcp](https://github.com/datakurre/bpmn-js-mcp) fijado en
  `package.json`). Guarda los diagramas en construcción en `.bpmn-mcp/`.
- `.bpmnlintrc` → reglas de validación para diagramas de documentación
  (sin las reglas de Camunda 7 ejecutable).
- `modelador/` → modelador web (bpmn-js, sin build). Modos: local en vivo,
  en línea (GitHub Pages) y página autocontenida.
- `scripts/servidor-modelador.mjs` → `npm run modelador`: sirve el modelador en
  http://localhost:3030 con recarga en vivo de `diagramas/` y `.bpmn-mcp/`.
- `scripts/subir-a-camunda.mjs` → `npm run camunda`: sube a Camunda 8
  (Camunda Hub API v2) usando las credenciales de `.env`.
- `scripts/pagina-modelador.mjs` → `npm run pagina`: HTML de un solo archivo con
  el modelador y el diagrama incrustados.
- `scripts/bpmn-cli.mjs` → `npm run bpmn`: llama a las herramientas del MCP
  desde la terminal.
- `scripts/construir-sitio.mjs` + `.github/workflows/pages.yml` → GitHub Pages.

## Desarrollo

- Node.js 22+, módulos ES (`.mjs`), sin dependencias de build; nombres y
  comentarios en español.
- `npm install` instala bpmn-js-mcp desde GitHub (lo compila; tarda ~1 min).
  El hook `SessionStart` lo hace solo si falta.
- Pruebas: `npm test` (incluye una prueba de integración real con el MCP).
- Los diagramas terminados van en `diagramas/` (se versionan); `.bpmn-mcp/`,
  `exportados/`, `_sitio/` y `.env` están ignorados.
