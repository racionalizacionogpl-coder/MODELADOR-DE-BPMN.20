import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginaAutocontenida } from '../scripts/lib/pagina.mjs';
import { aSlug, esNombreBpmnValido, nombreDelXml } from '../scripts/lib/rutas.mjs';

test('la página autocontenida incluye bpmn-js, la app y el diagrama sin referencias externas', async () => {
  const xml = '<bpmn:definitions><bpmn:process name="A</script><b>"/></bpmn:definitions>';
  const html = await paginaAutocontenida({ xml, nombre: 'Compras & <Pagos>' });

  assert.match(html, /<title>Compras &#38; &#60;Pagos&#62;<\/title>/);
  assert.match(html, /window\.DIAGRAMA_INCRUSTADO = /);
  assert.match(html, /bpmn-js - bpmn-modeler v18\./);
  assert.doesNotMatch(html, /src="app\.js"|href="estilos\.css"/);
  // El XML no puede cerrar la etiqueta <script> que lo contiene.
  assert.equal(html.match(/<\/script>/g).length, html.match(/<script\b/g).length);
  assert.doesNotMatch(html, /A<\/script>/);
});

test('la versión para Artifact no trae envoltorio html/body y desactiva las descargas', async () => {
  const xml = '<bpmn:definitions><bpmn:process name="P"/></bpmn:definitions>';
  const normal = await paginaAutocontenida({ xml, nombre: 'P' });
  const artifact = await paginaAutocontenida({ xml, nombre: 'P', paraArtifact: true });

  assert.match(normal, /^<!doctype html>/i);
  assert.doesNotMatch(artifact.slice(0, 2000), /<!doctype|<html|<head>|<body>|<meta charset/i);
  assert.match(artifact.slice(0, 8192), /<title>P<\/title>/);
  assert.match(artifact, /"artifact":true/);
  assert.doesNotMatch(normal, /"artifact":true/);
  // El código incrustado queda intacto: la página solo difiere en el envoltorio y la marca.
  const sinMarca = artifact.replace(',"artifact":true', '');
  assert.ok(normal.includes(sinMarca.slice(sinMarca.indexOf('<script>'))));
});

test('utilidades de nombres', () => {
  assert.equal(aSlug('Solicitud de Compra — Área Norte'), 'solicitud-de-compra-area-norte');
  assert.equal(aSlug('¿?'), 'diagrama');
  assert.ok(esNombreBpmnValido('alta-de-proveedor.bpmn'));
  assert.ok(esNombreBpmnValido('Atención al cliente.bpmn'));
  for (const malo of ['../x.bpmn', 'a/b.bpmn', '.oculto.bpmn', 'x.xml', 'x.bpmn\u0000']) {
    assert.equal(esNombreBpmnValido(malo), false, malo);
  }
  const xml = '<bpmn:participant name="Empresa"/><bpmn:process id="P" name="Compras &amp; pagos">';
  assert.equal(nombreDelXml(xml, 'r'), 'Compras & pagos');
  assert.equal(nombreDelXml('<definitions/>', 'respaldo'), 'respaldo');
});
