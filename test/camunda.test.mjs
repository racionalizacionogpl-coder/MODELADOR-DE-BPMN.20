// Prueba la subida a Camunda contra un servidor falso que imita el OAuth de
// Camunda SaaS y la Camunda Hub API v2 (POST /files, /files/search, PATCH...).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClienteCamunda, enlaceDiagrama, prepararParaCamunda8, subirDiagrama } from '../scripts/subir-a-camunda.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_1">
  <bpmn:process id="Process_1" name="Prueba" isExecutable="true" camunda:historyTimeToLive="P180D" />
</bpmn:definitions>`;

let servidor;
let base;
const llamadas = [];
const archivos = new Map();
let tokensEmitidos = 0;

before(async () => {
  servidor = http.createServer(async (req, res) => {
    let cuerpo = '';
    for await (const trozo of req) cuerpo += trozo;
    llamadas.push({ metodo: req.method, ruta: req.url, cuerpo, auth: req.headers.authorization });
    const json = (estado, datos) => {
      res.writeHead(estado, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(datos));
    };

    if (req.url === '/oauth/token') {
      const datos = new URLSearchParams(cuerpo);
      if (datos.get('client_secret') !== 'secreto') return json(401, { error: 'invalid_client' });
      assert.equal(datos.get('grant_type'), 'client_credentials');
      assert.equal(datos.get('audience'), 'api.cloud.camunda.io');
      tokensEmitidos++;
      return json(200, { access_token: `token-${tokensEmitidos}`, expires_in: 300 });
    }
    if (!req.headers.authorization?.startsWith('Bearer token-')) return json(401, { title: 'Unauthorized' });

    if (req.url === '/api/v2/info') return json(200, { version: 'v2' });
    if (req.url === '/api/v2/projects/search') {
      return json(200, { items: [{ projectKey: 'proy-1', name: 'Procesos', workspaceKey: 'ws-1' }], page: { totalItems: 1 } });
    }
    if (req.url === '/api/v2/files/search' && req.method === 'POST') {
      const { filter } = JSON.parse(cuerpo);
      const items = [...archivos.values()]
        .filter((a) => a.projectKey === filter.projectKey && a.name === filter.name && a.type === filter.type)
        .map((a) => ({ ...a, content: null }));
      return json(200, { items, page: { totalItems: items.length } });
    }
    if (req.url === '/api/v2/files' && req.method === 'POST') {
      const datos = JSON.parse(cuerpo);
      const archivo = { ...datos, fileKey: `f-${archivos.size + 1}`, revision: 1, simplePath: `${datos.name}.bpmn` };
      archivos.set(archivo.fileKey, archivo);
      return json(200, archivo);
    }
    const clave = req.url.match(/^\/api\/v2\/files\/([\w-]+)$/)?.[1];
    if (clave && archivos.has(clave)) {
      const archivo = archivos.get(clave);
      if (req.method === 'GET') return json(200, archivo);
      if (req.method === 'PATCH') {
        const datos = JSON.parse(cuerpo);
        if (datos.revision !== archivo.revision) return json(409, { title: 'Conflict', detail: 'revisión vieja' });
        Object.assign(archivo, { content: datos.content, revision: archivo.revision + 1 });
        return json(200, archivo);
      }
    }
    return json(404, { title: 'Not Found' });
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => servidor.close());

const configuracion = (cambios = {}) => ({
  clientId: 'cliente',
  clientSecret: 'secreto',
  oauthUrl: `${base}/oauth/token`,
  audiencia: 'api.cloud.camunda.io',
  apiUrl: `${base}/api/v2`,
  proyecto: 'proy-1',
  carpeta: null,
  versionPlataforma: '8.10.0',
  ...cambios,
});

test('prepararParaCamunda8 quita atributos de Camunda 7 y marca la plataforma', () => {
  const resultado = prepararParaCamunda8(XML, '8.10.0');
  assert.doesNotMatch(resultado, /camunda:historyTimeToLive/);
  assert.doesNotMatch(resultado, /xmlns:camunda=/);
  assert.match(resultado, /xmlns:modeler="http:\/\/camunda.org\/schema\/modeler\/1.0"/);
  assert.match(resultado, /modeler:executionPlatform="Camunda Cloud"/);
  assert.match(resultado, /modeler:executionPlatformVersion="8.10.0"/);
  // Idempotente
  assert.equal(prepararParaCamunda8(resultado, '8.10.0'), resultado);
});

test('prepararParaCamunda8 conserva el namespace si quedan elementos camunda:', () => {
  const conExtension = XML.replace(
    '/>\n</bpmn:definitions>',
    '><bpmn:extensionElements><camunda:properties /></bpmn:extensionElements></bpmn:process>\n</bpmn:definitions>'
  );
  assert.match(prepararParaCamunda8(conExtension), /xmlns:camunda=/);
});

test('enlaceDiagrama apunta al modelador de Camunda Hub', () => {
  assert.equal(enlaceDiagrama('https://hub.cloud.camunda.io/api/v2', 'abc'), 'https://hub.cloud.camunda.io/diagrams/abc');
});

test('crea el archivo la primera vez y lo actualiza con la revisión después', async () => {
  const primero = await subirDiagrama({ xml: XML, nombre: 'prueba', config: configuracion() });
  assert.equal(primero.accion, 'creado');
  assert.equal(primero.enlace, `${base}/diagrams/${primero.fileKey}`);
  const creado = archivos.get(primero.fileKey);
  assert.equal(creado.type, 'bpmn');
  assert.equal(creado.projectKey, 'proy-1');
  assert.match(creado.content, /executionPlatform="Camunda Cloud"/);

  const segundo = await subirDiagrama({ xml: XML.replace('Prueba', 'Prueba 2'), nombre: 'prueba', config: configuracion() });
  assert.equal(segundo.accion, 'actualizado');
  assert.equal(segundo.fileKey, primero.fileKey);
  assert.equal(archivos.get(primero.fileKey).revision, 2);
  assert.match(archivos.get(primero.fileKey).content, /Prueba 2/);
});

test('--sin-convertir sube el XML tal cual', async () => {
  const { fileKey } = await subirDiagrama({ xml: XML, nombre: 'original', sinConvertir: true, config: configuracion() });
  assert.equal(archivos.get(fileKey).content, XML);
});

test('reutiliza el token mientras no venza', async () => {
  const cliente = new ClienteCamunda(configuracion());
  const antes = tokensEmitidos;
  await cliente.info();
  await cliente.proyectos();
  assert.equal(tokensEmitidos, antes + 1);
});

test('errores claros: sin credenciales, credenciales malas y sin proyecto', async () => {
  await assert.rejects(new ClienteCamunda(configuracion({ clientSecret: undefined })).info(), /CAMUNDA_CONSOLE_CLIENT_SECRET/);
  await assert.rejects(new ClienteCamunda(configuracion({ clientSecret: 'mal' })).info(), /HTTP 401/);
  await assert.rejects(subirDiagrama({ xml: XML, nombre: 'x', config: configuracion({ proyecto: undefined }) }), /CAMUNDA_PROJECT_KEY/);
});
