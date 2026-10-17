#!/usr/bin/env node
// Arranca el servidor MCP de BPMN 2.0 (bpmn-js-mcp) para Claude Code.
// Lo invoca .mcp.json; también sirve para registrarlo a mano:
//   claude mcp add --scope user bpmn -- node "<ruta>/scripts/iniciar-mcp-bpmn.mjs"
//
// - Instala las dependencias si faltan.
// - Guarda cada diagrama en construcción en .bpmn-mcp/ (el modelador web lo
//   muestra en vivo mientras Claude lo dibuja).
// - Trabaja desde la raíz del proyecto, así `diagramas/x.bpmn` siempre apunta
//   a la carpeta diagramas/ del repositorio.

import { spawn } from 'node:child_process';
import { asegurarDependencias } from './lib/instalacion.mjs';
import { CARPETA_MCP, RAIZ, SERVIDOR_MCP } from './lib/rutas.mjs';

try {
  await asegurarDependencias();
} catch (error) {
  console.error(`[bpmn] No se pudo preparar el servidor MCP: ${error.message}`);
  console.error('[bpmn] Ejecuta "npm install" en la carpeta del proyecto y vuelve a conectar con /mcp.');
  process.exit(1);
}

const hijo = spawn(
  process.execPath,
  [SERVIDOR_MCP, '--persist-dir', CARPETA_MCP, ...process.argv.slice(2)],
  { cwd: RAIZ, stdio: 'inherit' }
);

for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(senal, () => hijo.kill(senal));
}
hijo.on('exit', (codigo, senal) => process.exit(codigo ?? (senal ? 1 : 0)));
