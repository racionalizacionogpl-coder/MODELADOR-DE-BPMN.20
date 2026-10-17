#!/usr/bin/env node
// Genera una página HTML de un solo archivo con el modelador y el diagrama
// incrustados: se abre con doble clic, se envía por correo o se publica en
// línea (por ejemplo, como Artifact de claude.ai) sin instalar nada.
//
//   npm run pagina -- diagramas/solicitud-de-compra.bpmn
//   npm run pagina -- diagramas/x.bpmn --salida /ruta/x.html
//   npm run pagina -- diagramas/x.bpmn --artifact     (para publicar como Artifact de claude.ai)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { paginaAutocontenida } from './lib/pagina.mjs';
import { RAIZ, aSlug, nombreDelXml } from './lib/rutas.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { salida: { type: 'string' }, nombre: { type: 'string' }, artifact: { type: 'boolean', default: false } },
});

if (!positionals[0]) {
  console.log('Uso: npm run pagina -- <archivo.bpmn> [--salida <archivo.html>] [--nombre <título>] [--artifact]');
  process.exit(1);
}

try {
  const origen = path.resolve(positionals[0]);
  const xml = await readFile(origen, 'utf8');
  const nombre = values.nombre || nombreDelXml(xml, path.basename(origen, '.bpmn'));
  const salida = path.resolve(values.salida || path.join(RAIZ, 'exportados', `${aSlug(nombre)}.html`));
  await mkdir(path.dirname(salida), { recursive: true });
  await writeFile(salida, await paginaAutocontenida({ xml, nombre, paraArtifact: values.artifact }), 'utf8');
  console.log(`Página del modelador generada: ${path.relative(process.cwd(), salida) || salida}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
