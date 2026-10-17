#!/usr/bin/env node
// Modelador BPMN 2.0 en el navegador, con recarga en vivo.
//
//   npm run modelador                    → http://localhost:3030
//   npm run modelador -- --abrir         → además abre el navegador
//   npm run modelador -- --puerto 8080
//
// Muestra los diagramas de diagramas/ y los que Claude está construyendo con
// el MCP (.bpmn-mcp/). Cada vez que Claude cambia un diagrama, la página se
// actualiza sola. Lo que edites en el navegador se guarda en diagramas/.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CARPETA_BPMN_JS,
  CARPETA_DIAGRAMAS,
  CARPETA_MCP,
  CARPETA_WEB,
  esNombreBpmnValido,
  nombreDelXml,
} from './lib/rutas.mjs';
import { cargarEnv, credencialesConfiguradas, subirDiagrama } from './subir-a-camunda.mjs';

const LIMITE_SUBIDA = 10 * 1024 * 1024;

const ORIGENES = {
  diagramas: { carpeta: CARPETA_DIAGRAMAS, escritura: true },
  mcp: { carpeta: CARPETA_MCP, escritura: false },
};

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bpmn': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

export async function listarDiagramas() {
  const lista = [];
  for (const [origen, { carpeta }] of Object.entries(ORIGENES)) {
    let archivos = [];
    try {
      archivos = (await fs.readdir(carpeta)).filter(esNombreBpmnValido);
    } catch {
      continue;
    }
    for (const archivo of archivos) {
      const ruta = path.join(carpeta, archivo);
      let info;
      let xml;
      try {
        [info, xml] = await Promise.all([fs.stat(ruta), fs.readFile(ruta, 'utf8')]);
      } catch {
        continue; // se borró mientras listábamos
      }
      let nombre = nombreDelXml(xml, archivo.replace(/\.bpmn$/, ''));
      if (origen === 'mcp') {
        try {
          const meta = JSON.parse(await fs.readFile(ruta.replace(/\.bpmn$/, '.meta.json'), 'utf8'));
          nombre = meta.name || nombre;
        } catch {
          // sin metadatos: nos quedamos con el nombre del XML
        }
      }
      lista.push({ origen, archivo, nombre, modificado: info.mtimeMs });
    }
  }
  return lista.sort((a, b) => b.modificado - a.modificado);
}

function responder(res, estado, cuerpo, tipo = 'application/json; charset=utf-8') {
  res.writeHead(estado, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo));
}

async function servirArchivo(res, base, relativa) {
  const ruta = path.resolve(base, '.' + path.posix.normalize('/' + relativa));
  if (!ruta.startsWith(base + path.sep) && ruta !== base) return responder(res, 403, { error: 'Ruta no permitida' });
  try {
    const info = await fs.stat(ruta);
    if (!info.isFile()) throw new Error('no es archivo');
  } catch {
    return responder(res, 404, { error: 'No encontrado' });
  }
  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(ruta)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(ruta).pipe(res);
}

async function leerCuerpo(req) {
  const trozos = [];
  let total = 0;
  for await (const trozo of req) {
    total += trozo.length;
    if (total > LIMITE_SUBIDA) throw Object.assign(new Error('Archivo demasiado grande'), { estado: 413 });
    trozos.push(trozo);
  }
  return Buffer.concat(trozos).toString('utf8');
}

// ── Recarga en vivo (Server-Sent Events) ────────────────────────────────────

const clientesEnVivo = new Set();

function avisar(evento) {
  const mensaje = `event: cambio\ndata: ${JSON.stringify(evento)}\n\n`;
  for (const res of clientesEnVivo) res.write(mensaje);
}

const huella = (texto) => createHash('sha1').update(texto).digest('hex');

async function leerHuella(ruta) {
  try {
    return huella(await fs.readFile(ruta));
  } catch {
    return null; // el archivo ya no existe
  }
}

function vigilarCarpetas() {
  const pendientes = new Map();
  // Solo avisamos cuando el contenido cambia: al cerrarse, el MCP reescribe
  // todos sus diagramas aunque no hayan cambiado.
  const huellas = new Map();
  for (const [origen, { carpeta }] of Object.entries(ORIGENES)) {
    mkdirSync(carpeta, { recursive: true });
    for (const archivo of readdirSync(carpeta).filter(esNombreBpmnValido)) {
      huellas.set(`${origen}/${archivo}`, huella(readFileSync(path.join(carpeta, archivo))));
    }
    watch(carpeta, (_tipo, archivo) => {
      if (!archivo || !esNombreBpmnValido(archivo)) return;
      // El MCP escribe el archivo y luego lo relee: agrupamos ráfagas.
      const clave = `${origen}/${archivo}`;
      clearTimeout(pendientes.get(clave));
      pendientes.set(
        clave,
        setTimeout(async () => {
          pendientes.delete(clave);
          const nueva = await leerHuella(path.join(carpeta, archivo));
          if (nueva === (huellas.get(clave) ?? null)) return;
          if (nueva) huellas.set(clave, nueva);
          else huellas.delete(clave);
          avisar({ origen, archivo, existe: Boolean(nueva) });
        }, 200)
      );
    });
  }
}

// ── Rutas ───────────────────────────────────────────────────────────────────

export async function manejar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let partes;
  try {
    partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return responder(res, 400, { error: 'Ruta mal codificada' });
  }

  // Las escrituras solo se aceptan desde la propia página del modelador:
  // evita que otra web abierta en el navegador guarde o suba diagramas.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    let hostOrigen = null;
    try {
      hostOrigen = new URL(req.headers.origin).host;
    } catch {
      // "null" u otro origen opaco
    }
    if (hostOrigen !== req.headers.host) return responder(res, 403, { error: 'Origen no permitido' });
  }

  try {
    if (url.pathname === '/api/estado') {
      return responder(res, 200, { modo: 'local', enVivo: true, camunda: credencialesConfiguradas() });
    }

    if (url.pathname === '/api/camunda/subir' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return responder(res, 415, { error: 'Se esperaba application/json' });
      }
      const { xml, nombre } = JSON.parse(await leerCuerpo(req));
      if (!xml || !nombre) return responder(res, 400, { error: 'Faltan xml o nombre' });
      return responder(res, 200, await subirDiagrama({ xml, nombre }));
    }

    if (url.pathname === '/api/eventos') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clientesEnVivo.add(res);
      const latido = setInterval(() => res.write(': latido\n\n'), 25000);
      req.on('close', () => {
        clearInterval(latido);
        clientesEnVivo.delete(res);
      });
      return;
    }

    if (url.pathname === '/api/diagramas' && req.method === 'GET') {
      return responder(res, 200, await listarDiagramas());
    }

    if (partes[0] === 'api' && partes[1] === 'diagramas' && partes.length === 4) {
      const [, , origen, archivo] = partes;
      const destino = ORIGENES[origen];
      if (!destino || !esNombreBpmnValido(archivo)) {
        return responder(res, 400, { error: 'Origen o nombre de archivo no válido' });
      }
      const ruta = path.join(destino.carpeta, archivo);

      if (req.method === 'GET') {
        try {
          return responder(res, 200, await fs.readFile(ruta, 'utf8'), TIPOS['.bpmn']);
        } catch {
          return responder(res, 404, { error: 'Diagrama no encontrado' });
        }
      }

      if (req.method === 'PUT') {
        if (!destino.escritura) return responder(res, 403, { error: 'Solo se puede guardar en diagramas/' });
        const xml = await leerCuerpo(req);
        if (!/<(?:\w+:)?definitions\b/.test(xml)) {
          return responder(res, 400, { error: 'El contenido no es un BPMN 2.0 válido' });
        }
        await fs.mkdir(destino.carpeta, { recursive: true });
        await fs.writeFile(ruta, xml, 'utf8');
        return responder(res, 200, { ok: true, origen, archivo });
      }

      return responder(res, 405, { error: 'Método no permitido' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return responder(res, 405, { error: 'Método no permitido' });
    }
    if (partes[0] === 'vendor' && partes[1] === 'bpmn-js') {
      return servirArchivo(res, CARPETA_BPMN_JS, partes.slice(2).join('/'));
    }
    if (partes[0] === 'diagramas') {
      return servirArchivo(res, CARPETA_DIAGRAMAS, partes.slice(1).join('/'));
    }
    return servirArchivo(res, CARPETA_WEB, partes.length ? partes.join('/') : 'index.html');
  } catch (error) {
    return responder(res, error.estado ?? 500, { error: error.message });
  }
}

function abrirNavegador(direccion) {
  const [comando, ...args] =
    process.platform === 'darwin'
      ? ['open', direccion]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', direccion]
        : ['xdg-open', direccion];
  spawn(comando, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export function iniciar({ puerto = 3030, host = '127.0.0.1', abrir = false } = {}) {
  cargarEnv();
  vigilarCarpetas();
  const servidor = http.createServer(manejar);
  servidor.listen(puerto, host, () => {
    const direccion = `http://${host === '0.0.0.0' ? 'localhost' : host}:${servidor.address().port}`;
    console.log(`Modelador BPMN listo en ${direccion}`);
    console.log('Los diagramas que Claude cree o modifique aparecerán aquí automáticamente.');
    if (abrir) abrirNavegador(direccion);
  });
  return servidor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      puerto: { type: 'string', default: process.env.PUERTO ?? '3030' },
      host: { type: 'string', default: process.env.HOST_MODELADOR ?? '127.0.0.1' },
      abrir: { type: 'boolean', default: false },
    },
  });
  if (!existsSync(CARPETA_BPMN_JS)) {
    console.error('Aviso: falta node_modules/bpmn-js; ejecuta "npm install" (se usará el CDN como respaldo).');
  }
  iniciar({ puerto: Number(values.puerto), host: values.host, abrir: values.abrir });
}
