// Comprueba que las dependencias (bpmn-js-mcp y el SDK de MCP) estén instaladas
// y, si faltan, ejecuta `npm install` una sola vez aunque lo pidan varios
// procesos a la vez (el hook de inicio de sesión y el servidor MCP).
//
// Todos los mensajes van a stderr: cuando esto corre dentro del servidor MCP,
// stdout está reservado para el protocolo.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { RAIZ, SERVIDOR_MCP } from './rutas.mjs';

const CANDADO = path.join(RAIZ, '.instalando.lock');
const CANDADO_VENCIDO_MS = 10 * 60 * 1000;
const CLAVE_MCP = 'node_modules/bpmn-js-mcp';

function leerJson(ruta) {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Listas = existe el servidor compilado y la versión instalada de bpmn-js-mcp
 * es la que fija package-lock.json (así un `git pull` que cambie la versión
 * provoca una reinstalación).
 */
export function dependenciasListas() {
  if (!existsSync(SERVIDOR_MCP)) return false;
  const instalado = leerJson(path.join(RAIZ, 'node_modules', '.package-lock.json'));
  const fijado = leerJson(path.join(RAIZ, 'package-lock.json'));
  const resuelto = (lock) => lock?.packages?.[CLAVE_MCP]?.resolved;
  if (!instalado || !resuelto(instalado)) return false;
  return !fijado || resuelto(fijado) === resuelto(instalado);
}

function tomarCandado() {
  try {
    mkdirSync(CANDADO);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() - statSync(CANDADO).mtimeMs > CANDADO_VENCIDO_MS) {
      rmSync(CANDADO, { recursive: true, force: true });
      return tomarCandado();
    }
    return false;
  }
}

function ejecutarNpmInstall() {
  const windows = process.platform === 'win32';
  const resultado = spawnSync(
    windows ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: RAIZ, stdio: ['ignore', 2, 2], shell: windows }
  );
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) {
    throw new Error(`npm install terminó con código ${resultado.status}`);
  }
}

export async function asegurarDependencias() {
  if (dependenciasListas()) return;

  if (tomarCandado()) {
    try {
      console.error('[bpmn] Instalando dependencias (solo la primera vez, ~1-2 min)...');
      ejecutarNpmInstall();
      console.error('[bpmn] Dependencias instaladas.');
    } finally {
      rmSync(CANDADO, { recursive: true, force: true });
    }
  } else {
    console.error('[bpmn] Otro proceso está instalando las dependencias; esperando...');
    while (existsSync(CANDADO)) await esperar(2000);
    // Si el otro proceso falló o el candado venció, lo intentamos nosotros.
    return asegurarDependencias();
  }

  if (!existsSync(SERVIDOR_MCP)) {
    throw new Error(`No se encontró ${path.relative(RAIZ, SERVIDOR_MCP)} después de instalar.`);
  }
}
