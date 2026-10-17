// Integración real con el servidor MCP de BPMN (bpmn-js-mcp): lo arranca como
// lo haría Claude Code, dibuja un proceso en español, lo valida con la
// configuración de lint del proyecto y lo exporta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RAIZ, SERVIDOR_MCP } from '../scripts/lib/rutas.mjs';

async function conectar(args, cwd = RAIZ) {
  const cliente = new Client({ name: 'pruebas', version: '1.0.0' });
  await cliente.connect(new StdioClientTransport({ command: process.execPath, args, cwd, stderr: 'ignore' }));
  return cliente;
}

const json = (resultado) => JSON.parse(resultado.content[0].text);

test('el lanzador de .mcp.json expone las herramientas de BPMN', async () => {
  const cliente = await conectar([path.join(RAIZ, 'scripts', 'iniciar-mcp-bpmn.mjs')], os.tmpdir());
  try {
    const nombres = (await cliente.listTools()).tools.map((h) => h.name);
    for (const h of ['create_bpmn_diagram', 'add_bpmn_elements', 'connect_bpmn_elements', 'layout_bpmn_diagram', 'validate_bpmn_diagram', 'export_bpmn']) {
      assert.ok(nombres.includes(h), h);
    }
  } finally {
    await cliente.close();
  }
});

test('dibuja, valida sin avisos y exporta un proceso con nombres en español', async () => {
  const temporal = await mkdtemp(path.join(os.tmpdir(), 'bpmn-'));
  const cliente = await conectar([SERVIDOR_MCP, '--persist-dir', path.join(temporal, 'persistencia')]);
  try {
    const { diagramId } = json(await cliente.callTool({ name: 'create_bpmn_diagram', arguments: { name: 'Pago a proveedores', includeImage: false } }));
    await cliente.callTool({
      name: 'add_bpmn_elements',
      arguments: {
        diagramId,
        connect: 'chain',
        elements: [
          { elementType: 'bpmn:StartEvent', name: 'Factura recibida' },
          { elementType: 'bpmn:UserTask', name: 'Revisar factura' },
          { elementType: 'bpmn:ServiceTask', name: 'Programar pago' },
          { elementType: 'bpmn:EndEvent', name: 'Pago programado' },
        ],
      },
    });
    const validacion = json(await cliente.callTool({ name: 'validate_bpmn_diagram', arguments: { diagramId } }));
    assert.equal(validacion.errorCount, 0);
    assert.equal(validacion.warningCount, 0, JSON.stringify(validacion.issues));

    const destino = path.join(temporal, 'pago.bpmn');
    const exportado = await cliente.callTool({ name: 'export_bpmn', arguments: { diagramId, format: 'xml', filePath: destino } });
    assert.ok(!exportado.isError);
    const xml = await readFile(destino, 'utf8');
    assert.match(xml, /name="Revisar factura"/);
    assert.match(xml, /<bpmndi:BPMNShape/);
  } finally {
    await cliente.close();
    await rm(temporal, { recursive: true, force: true });
  }
});
