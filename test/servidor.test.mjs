import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { manejar } from '../scripts/servidor-modelador.mjs';
import { CARPETA_DIAGRAMAS } from '../scripts/lib/rutas.mjs';

const PRUEBA = '__prueba-servidor__.bpmn';
const XML = '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D"><bpmn:process id="P" name="Proceso de prueba" /></bpmn:definitions>';

let servidor;
let base;

before(async () => {
  servidor = http.createServer(manejar);
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  servidor.close();
  await rm(path.join(CARPETA_DIAGRAMAS, PRUEBA), { force: true });
});

const pedir = (ruta, opciones) => fetch(`${base}${ruta}`, opciones);

test('sirve la página, bpmn-js y el estado del modo local', async () => {
  const pagina = await pedir('/');
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Modelador BPMN 2.0/);
  assert.equal((await pedir('/vendor/bpmn-js/bpmn-modeler.production.min.js')).status, 200);
  const estado = await (await pedir('/api/estado')).json();
  assert.equal(estado.modo, 'local');
});

test('guarda en diagramas/ y lo lista con el nombre del proceso', async () => {
  const guardado = await pedir(`/api/diagramas/diagramas/${PRUEBA}`, { method: 'PUT', body: XML });
  assert.equal(guardado.status, 200);
  assert.equal(await readFile(path.join(CARPETA_DIAGRAMAS, PRUEBA), 'utf8'), XML);

  const lista = await (await pedir('/api/diagramas')).json();
  const entrada = lista.find((d) => d.archivo === PRUEBA);
  assert.equal(entrada?.nombre, 'Proceso de prueba');
  assert.equal(entrada?.origen, 'diagramas');

  assert.equal(await (await pedir(`/api/diagramas/diagramas/${PRUEBA}`)).text(), XML);
  assert.equal(await (await pedir(`/diagramas/${PRUEBA}`)).text(), XML);
});

test('rechaza rutas peligrosas, contenido inválido y escrituras no permitidas', async () => {
  assert.equal((await pedir('/api/diagramas/diagramas/..%2Fpackage.bpmn', { method: 'PUT', body: XML })).status, 400);
  assert.equal((await pedir('/api/diagramas/otro/x.bpmn')).status, 400);
  assert.equal((await pedir('/api/diagramas/diagramas/x.bpmn', { method: 'PUT', body: 'hola' })).status, 400);
  assert.equal((await pedir('/api/diagramas/mcp/x.bpmn', { method: 'PUT', body: XML })).status, 403);
  const otroOrigen = await pedir(`/api/diagramas/diagramas/${PRUEBA}`, {
    method: 'PUT',
    body: XML,
    headers: { Origin: 'http://malicioso.example' },
  });
  assert.equal(otroOrigen.status, 403);
  const subir = await pedir('/api/camunda/subir', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(subir.status, 415);
  for (const ruta of ['/diagramas/..%2F.env', '/vendor/bpmn-js/..%2F..%2F..%2Fpackage.json', '/%2e%2e/package.json']) {
    assert.notEqual((await pedir(ruta)).status, 200, ruta);
  }
  assert.equal(existsSync(path.join(CARPETA_DIAGRAMAS, '..', 'package.bpmn')), false);
});
