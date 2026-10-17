#!/usr/bin/env node
// Arma _sitio/ para publicar el modelador en GitHub Pages (lo usa
// .github/workflows/pages.yml): la página, bpmn-js y los diagramas del repo,
// con un índice para listarlos aunque la API de GitHub no responda.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CARPETA_BPMN_JS, CARPETA_DIAGRAMAS, CARPETA_WEB, RAIZ, esNombreBpmnValido, nombreDelXml } from './lib/rutas.mjs';

const SITIO = path.join(RAIZ, '_sitio');

await rm(SITIO, { recursive: true, force: true });
await cp(CARPETA_WEB, SITIO, { recursive: true });
await cp(CARPETA_BPMN_JS, path.join(SITIO, 'vendor', 'bpmn-js'), { recursive: true });
await mkdir(path.join(SITIO, 'diagramas'), { recursive: true });

const indice = [];
for (const archivo of (await readdir(CARPETA_DIAGRAMAS)).sort()) {
  if (!/\.(bpmn|svg|png)$/.test(archivo)) continue;
  await cp(path.join(CARPETA_DIAGRAMAS, archivo), path.join(SITIO, 'diagramas', archivo));
  if (esNombreBpmnValido(archivo)) {
    const xml = await readFile(path.join(CARPETA_DIAGRAMAS, archivo), 'utf8');
    indice.push({ archivo, nombre: nombreDelXml(xml, archivo.replace(/\.bpmn$/, '')) });
  }
}
await writeFile(path.join(SITIO, 'diagramas', 'indice.json'), JSON.stringify(indice, null, 2));

console.log(`Sitio listo en ${path.relative(process.cwd(), SITIO)}/ con ${indice.length} diagrama(s).`);
