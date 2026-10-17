#!/usr/bin/env node
// Sube (o actualiza) un diagrama .bpmn en Camunda 8 — el modelador web de
// Camunda Hub (antes "Web Modeler") — usando la Camunda Hub API v2.
//
//   npm run camunda -- probar                         Verifica credenciales
//   npm run camunda -- proyectos                      Lista proyectos y sus claves
//   npm run camunda -- subir diagramas/x.bpmn         Crea o actualiza el archivo
//   npm run camunda -- subir diagramas/x.bpmn --nombre "Mi proceso" --proyecto <clave>
//
// Credenciales en .env (ver .env.example). Se crean en Camunda:
// Organization > Manage organization > Administration API > Create new credentials,
// con permisos para "Hub API" (o "Web Modeler API").

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RAIZ } from './lib/rutas.mjs';

const PREDETERMINADOS = {
  CAMUNDA_OAUTH_URL: 'https://login.cloud.camunda.io/oauth/token',
  CAMUNDA_CONSOLE_OAUTH_AUDIENCE: 'api.cloud.camunda.io',
  CAMUNDA_HUB_API_URL: 'https://hub.cloud.camunda.io/api/v2',
  CAMUNDA_VERSION_PLATAFORMA: '8.10.0',
};

export function leerConfiguracion(entorno = process.env) {
  const valor = (clave) => entorno[clave] || PREDETERMINADOS[clave];
  return {
    clientId: entorno.CAMUNDA_CONSOLE_CLIENT_ID,
    clientSecret: entorno.CAMUNDA_CONSOLE_CLIENT_SECRET,
    oauthUrl: valor('CAMUNDA_OAUTH_URL'),
    audiencia: valor('CAMUNDA_CONSOLE_OAUTH_AUDIENCE'),
    apiUrl: valor('CAMUNDA_HUB_API_URL').replace(/\/+$/, ''),
    proyecto: entorno.CAMUNDA_PROJECT_KEY,
    carpeta: entorno.CAMUNDA_FOLDER_KEY || null,
    versionPlataforma: valor('CAMUNDA_VERSION_PLATAFORMA'),
  };
}

export function cargarEnv() {
  try {
    process.loadEnvFile(path.join(RAIZ, '.env'));
  } catch {
    // sin .env: se usan las variables de entorno del sistema
  }
}

export function credencialesConfiguradas(config = leerConfiguracion()) {
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * Deja el XML listo para Camunda 8: quita atributos camunda:* de Camunda 7
 * (p. ej. historyTimeToLive, que añade bpmn-js-mcp) y marca la plataforma de
 * ejecución para que el modelador web lo abra como diagrama de Camunda 8.
 */
export function prepararParaCamunda8(xml, versionPlataforma = PREDETERMINADOS.CAMUNDA_VERSION_PLATAFORMA) {
  let resultado = xml.replace(/\s+camunda:[\w-]+="[^"]*"/g, '');
  if (!/<camunda:/.test(resultado)) {
    resultado = resultado.replace(/\s+xmlns:camunda="[^"]*"/, '');
  }
  if (!/modeler:executionPlatform=/.test(resultado)) {
    resultado = resultado.replace(/<((?:\w+:)?definitions)\b/, (inicio) => {
      const ns = /xmlns:modeler=/.test(resultado) ? '' : ' xmlns:modeler="http://camunda.org/schema/modeler/1.0"';
      return `${inicio}${ns} modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="${versionPlataforma}"`;
    });
  }
  return resultado;
}

/** "https://hub.cloud.camunda.io/api/v2" → "https://hub.cloud.camunda.io/diagrams/<clave>" */
export function enlaceDiagrama(apiUrl, fileKey) {
  return `${apiUrl.replace(/\/api\/v\d+$/, '')}/diagrams/${fileKey}`;
}

export class ClienteCamunda {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenVence = 0;
  }

  async obtenerToken() {
    if (this.token && Date.now() < this.tokenVence) return this.token;
    const { oauthUrl, audiencia, clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) {
      throw new Error('Faltan CAMUNDA_CONSOLE_CLIENT_ID y CAMUNDA_CONSOLE_CLIENT_SECRET (copia .env.example a .env).');
    }
    const respuesta = await this.fetch(oauthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        audience: audiencia,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!respuesta.ok) {
      throw new Error(`No se pudo obtener el token de Camunda (HTTP ${respuesta.status}). Revisa el client id/secret.`);
    }
    const datos = await respuesta.json();
    this.token = datos.access_token;
    // Renovamos 30 s antes de que venza (Camunda suele dar 300 s).
    this.tokenVence = Date.now() + Math.max(0, (datos.expires_in ?? 300) - 30) * 1000;
    return this.token;
  }

  async api(metodo, ruta, cuerpo) {
    const respuesta = await this.fetch(`${this.config.apiUrl}${ruta}`, {
      method: metodo,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${await this.obtenerToken()}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const texto = await respuesta.text();
    let datos = null;
    try {
      datos = texto ? JSON.parse(texto) : null;
    } catch {
      datos = { detail: texto };
    }
    if (!respuesta.ok) {
      const detalle = datos?.detail || datos?.title || texto || respuesta.statusText;
      const pista =
        respuesta.status === 401 || respuesta.status === 403
          ? ' (¿el cliente tiene permisos para la Hub API / Web Modeler API?)'
          : '';
      throw new Error(`Camunda respondió ${respuesta.status} en ${metodo} ${ruta}: ${detalle}${pista}`);
    }
    return datos;
  }

  info() {
    return this.api('GET', '/info');
  }

  async proyectos() {
    const datos = await this.api('POST', '/projects/search', { page: { limit: 200 } });
    return datos?.items ?? [];
  }

  /**
   * Crea el archivo o, si ya existe uno con el mismo nombre en el proyecto,
   * actualiza su contenido (la API exige la revisión actual para actualizar).
   */
  async subirArchivo({ nombre, contenido, proyecto, carpeta = null }) {
    if (!proyecto) {
      throw new Error('Falta la clave del proyecto: define CAMUNDA_PROJECT_KEY en .env o usa --proyecto (ver "npm run camunda -- proyectos").');
    }
    const filtro = { projectKey: proyecto, name: nombre, type: 'bpmn' };
    if (carpeta) filtro.folderKey = carpeta;
    const existentes = (await this.api('POST', '/files/search', { filter: filtro, page: { limit: 1 } }))?.items ?? [];

    if (existentes.length) {
      const actual = await this.api('GET', `/files/${existentes[0].fileKey}`);
      const archivo = await this.api('PATCH', `/files/${actual.fileKey}`, {
        content: contenido,
        revision: actual.revision,
      });
      return { accion: 'actualizado', archivo };
    }

    const archivo = await this.api('POST', '/files', {
      name: nombre,
      projectKey: proyecto,
      ...(carpeta ? { folderKey: carpeta } : {}),
      type: 'bpmn',
      content: contenido,
    });
    return { accion: 'creado', archivo };
  }
}

/** Usado por la CLI y por el botón "Subir a Camunda" del modelador. */
export async function subirDiagrama({ xml, nombre, proyecto, carpeta, sinConvertir = false, config = leerConfiguracion() }) {
  const cliente = new ClienteCamunda(config);
  const contenido = sinConvertir ? xml : prepararParaCamunda8(xml, config.versionPlataforma);
  const { accion, archivo } = await cliente.subirArchivo({
    nombre,
    contenido,
    proyecto: proyecto || config.proyecto,
    carpeta: carpeta || config.carpeta,
  });
  return { accion, fileKey: archivo.fileKey, ruta: archivo.simplePath, enlace: enlaceDiagrama(config.apiUrl, archivo.fileKey) };
}

const AYUDA = `Uso:
  npm run camunda -- probar
  npm run camunda -- proyectos
  npm run camunda -- subir <archivo.bpmn> [--nombre <nombre>] [--proyecto <clave>] [--carpeta <clave>] [--sin-convertir]`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      nombre: { type: 'string' },
      proyecto: { type: 'string' },
      carpeta: { type: 'string' },
      'sin-convertir': { type: 'boolean', default: false },
      ayuda: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [comando, archivo] = positionals;
  if (values.ayuda || !comando) {
    console.log(AYUDA);
    return;
  }

  cargarEnv();
  const config = leerConfiguracion();
  const cliente = new ClienteCamunda(config);

  if (comando === 'probar') {
    const info = await cliente.info();
    console.log('Conexión correcta con Camunda Hub API:');
    console.log(JSON.stringify(info, null, 2));
  } else if (comando === 'proyectos') {
    const proyectos = await cliente.proyectos();
    if (!proyectos.length) console.log('No hay proyectos. Crea uno en Camunda (Hub) o con la API.');
    for (const p of proyectos) console.log(`${p.projectKey}  ${p.name}`);
    if (proyectos.length) console.log('\nCopia la clave del proyecto en CAMUNDA_PROJECT_KEY dentro de .env');
  } else if (comando === 'subir') {
    if (!archivo) throw new Error('Indica el archivo .bpmn a subir.');
    const xml = await readFile(path.resolve(archivo), 'utf8');
    const nombre = values.nombre || path.basename(archivo).replace(/\.bpmn$/i, '');
    const resultado = await subirDiagrama({
      xml,
      nombre,
      proyecto: values.proyecto,
      carpeta: values.carpeta,
      sinConvertir: values['sin-convertir'],
      config,
    });
    console.log(`Diagrama ${resultado.accion} en Camunda: ${resultado.ruta ?? nombre}`);
    console.log(`Ábrelo en el modelador de Camunda: ${resultado.enlace}`);
  } else {
    console.log(AYUDA);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
