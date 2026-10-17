// Arma la página del modelador en un solo archivo HTML, con bpmn-js, los
// estilos y (opcionalmente) un diagrama incrustados. No necesita servidor ni
// internet: se puede publicar como Artifact de claude.ai, enviar por correo o
// abrir con doble clic.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CARPETA_BPMN_JS, CARPETA_WEB } from './rutas.mjs';

/** Evita que el contenido cierre la etiqueta <script> o <style> que lo envuelve. */
const protegerScript = (codigo) => codigo.replace(/<\/script/gi, '<\\/script');
const protegerEstilo = (codigo) => codigo.replace(/<\/style/gi, '<\\/style');

export async function paginaAutocontenida({ xml, nombre }) {
  const leer = (base, relativa) => readFile(path.join(base, relativa), 'utf8');
  const [html, estilos, app, bpmnJs, ...cssBpmnJs] = await Promise.all([
    leer(CARPETA_WEB, 'index.html'),
    leer(CARPETA_WEB, 'estilos.css'),
    leer(CARPETA_WEB, 'app.js'),
    leer(CARPETA_BPMN_JS, 'bpmn-modeler.production.min.js'),
    leer(CARPETA_BPMN_JS, 'assets/diagram-js.css'),
    leer(CARPETA_BPMN_JS, 'assets/bpmn-js.css'),
    leer(CARPETA_BPMN_JS, 'assets/bpmn-font/css/bpmn-embedded.css'),
  ]);

  // JSON dentro de <script>: escapamos "<" para que el XML no pueda cerrar la etiqueta.
  const datos = JSON.stringify({ xml, nombre }).replace(/</g, '\\u003c');
  const titulo = nombre.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

  return html
    .replace('<title>Modelador BPMN 2.0</title>', () => `<title>${titulo}</title>`)
    .replace(
      '<link rel="stylesheet" href="estilos.css" />',
      () => `<style>\n${protegerEstilo([...cssBpmnJs, estilos].join('\n'))}\n</style>`
    )
    .replace(
      '<script type="module" src="app.js"></script>',
      () =>
        `<script>window.DIAGRAMA_INCRUSTADO = ${datos};</script>\n` +
        `<script>\n${protegerScript(bpmnJs)}\n</script>\n` +
        `<script type="module">\n${protegerScript(app)}\n</script>`
    );
}
