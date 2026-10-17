#!/usr/bin/env node
// Hook SessionStart de Claude Code (ver .claude/settings.json).
// Deja instaladas las dependencias del MCP de BPMN al abrir la sesión, tanto
// en local como en las sesiones en la nube de claude.ai/code. Si ya están
// instaladas no hace nada.

import { asegurarDependencias } from './lib/instalacion.mjs';

try {
  await asegurarDependencias();
} catch (error) {
  console.error(`[bpmn] No se pudieron instalar las dependencias: ${error.message}`);
  // No bloqueamos la sesión: Claude puede reintentar con "npm install".
}
