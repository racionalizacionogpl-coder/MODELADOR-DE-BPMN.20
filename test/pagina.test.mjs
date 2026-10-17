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
