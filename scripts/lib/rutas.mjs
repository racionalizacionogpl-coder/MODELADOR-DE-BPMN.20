import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Diagramas terminados: se versionan en git y se suben a Camunda. */
export const CARPETA_DIAGRAMAS = path.join(RAIZ, 'diagramas');

/** Diagramas en construcción que el servidor MCP guarda tras cada cambio. */
export const CARPETA_MCP = path.join(RAIZ, '.bpmn-mcp');

export const SERVIDOR_MCP = path.join(RAIZ, 'node_modules', 'bpmn-js-mcp', 'dist', 'index.js');

/** Página del modelador web y la distribución de bpmn-js que usa. */
export const CARPETA_WEB = path.join(RAIZ, 'modelador');
export const CARPETA_BPMN_JS = path.join(RAIZ, 'node_modules', 'bpmn-js', 'dist');

/** Nombre legible: el del proceso o pool dentro del XML, o el de respaldo. */
export function nombreDelXml(xml, respaldo) {
  const etiqueta =
    xml.match(/<(?:bpmn2?:)?process\b[^>]*\bname="([^"]+)"/) ??
    xml.match(/<(?:bpmn2?:)?participant\b[^>]*\bname="([^"]+)"/);
  return etiqueta ? etiqueta[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : respaldo;
}

/** Nombre de archivo .bpmn sin rutas ni caracteres peligrosos. */
export function esNombreBpmnValido(nombre) {
  return (
    typeof nombre === 'string' &&
    nombre === path.basename(nombre) &&
    !nombre.startsWith('.') &&
    /^[\p{L}\p{N}_. -]+\.bpmn$/u.test(nombre)
  );
}

/** "Proceso de Compras" → "proceso-de-compras" (para nombres de archivo). */
export function aSlug(texto) {
  return (
    String(texto)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'diagrama'
  );
}
