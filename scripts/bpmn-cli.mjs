#!/usr/bin/env node
// Llama a las herramientas del MCP de BPMN desde la terminal.
// Sirve cuando el MCP todavía no está conectado en la sesión de Claude Code
// (por ejemplo, la primera vez, antes de reiniciar) y para automatizar.
// Usa la misma carpeta .bpmn-mcp/ que el servidor MCP, así que los
// diagramas se comparten entre ambos.
//
//   npm run bpmn -- herramientas
//   npm run bpmn -- describir add_bpmn_elements
//   npm run bpmn -- llamar list_bpmn_diagrams
//   npm run bpmn -- llamar export_bpmn '{"diagramId":"...","format":"xml","filePath":"diagramas/x.bpmn"}'
//   npm run bpmn -- ejecutar pasos.json        (o "-" para leer de stdin)
//
// Formato de pasos.json: [{ "herramienta": "create_bpmn_diagram", "argumentos": { ... } }, ...]
// El texto {{diagramId}} se reemplaza por el último diagramId devuelto.

import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { asegurarDependencias } from './lib/instalacion.mjs';
import { CARPETA_MCP, RAIZ, SERVIDOR_MCP } from './lib/rutas.mjs';

const AYUDA = `Uso:
  npm run bpmn -- herramientas                 Lista las herramientas del MCP
  npm run bpmn -- describir <herramienta>      Muestra los argumentos que acepta
  npm run bpmn -- llamar <herramienta> [json]  Ejecuta una herramienta
  npm run bpmn -- ejecutar <pasos.json | ->    Ejecuta varios pasos seguidos`;

async function leerEntrada(origen) {
  if (origen !== '-') return readFile(origen, 'utf8');
  let texto = '';
  for await (const trozo of process.stdin) texto += trozo;
  return texto;
}

function textoDelResultado(resultado) {
  return (resultado.content ?? [])
    .map((parte) => (parte.type === 'text' ? parte.text : `[${parte.type} omitido]`))
    .join('\n');
}

function extraerDiagramId(texto) {
  return texto.match(/"diagramId":\s*"([^"]+)"/)?.[1];
}

function sustituir(valor, diagramId) {
  if (typeof valor === 'string') return valor.replaceAll('{{diagramId}}', diagramId ?? '{{diagramId}}');
  if (Array.isArray(valor)) return valor.map((v) => sustituir(v, diagramId));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, sustituir(v, diagramId)]));
  }
  return valor;
}

async function conectar() {
  await asegurarDependencias();
  const cliente = new Client({ name: 'bpmn-cli', version: '1.0.0' });
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [SERVIDOR_MCP, '--persist-dir', CARPETA_MCP, '--hint-level', 'minimal'],
    cwd: RAIZ,
    stderr: 'ignore',
  });
  await cliente.connect(transporte);
  return { cliente, pid: transporte.pid };
}

/**
 * El servidor guarda todos los diagramas en .bpmn-mcp/ al recibir SIGTERM;
 * si solo se le cierra stdin termina sin guardar los recién creados.
 */
async function cerrarGuardando({ cliente, pid }) {
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        process.kill(pid, 0); // lanza ESRCH cuando el proceso ya terminó
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {
      // ya terminó
    }
  }
  await cliente.close();
}

async function main([comando, ...resto]) {
  if (!comando || comando === 'ayuda' || comando === '--help') {
    console.log(AYUDA);
    return 0;
  }

  const conexion = await conectar();
  const { cliente } = conexion;
  try {
    if (comando === 'herramientas') {
      const { tools } = await cliente.listTools();
      for (const h of tools) console.log(`${h.name.padEnd(30)} ${h.description.split('. ')[0]}`);
      return 0;
    }

    if (comando === 'describir') {
      const { tools } = await cliente.listTools();
      const herramienta = tools.find((h) => h.name === resto[0]);
      if (!herramienta) throw new Error(`No existe la herramienta "${resto[0]}"`);
      console.log(herramienta.description);
      console.log(JSON.stringify(herramienta.inputSchema, null, 2));
      return 0;
    }

    let pasos;
    if (comando === 'llamar') {
      pasos = [{ herramienta: resto[0], argumentos: resto[1] ? JSON.parse(resto[1]) : {} }];
    } else if (comando === 'ejecutar') {
      pasos = JSON.parse(await leerEntrada(resto[0] ?? '-'));
    } else {
      console.error(`Comando desconocido: ${comando}\n\n${AYUDA}`);
      return 1;
    }

    let diagramId;
    for (const [i, paso] of pasos.entries()) {
      const nombre = paso.herramienta ?? paso.tool;
      const argumentos = sustituir(paso.argumentos ?? paso.args ?? {}, diagramId);
      const resultado = await cliente.callTool({ name: nombre, arguments: argumentos });
      const texto = textoDelResultado(resultado);
      diagramId = extraerDiagramId(texto) ?? diagramId;
      console.log(`\n── Paso ${i + 1}: ${nombre}${resultado.isError ? ' ✗' : ''}\n${texto}`);
      if (resultado.isError) return 1;
    }
    return 0;
  } finally {
    await cerrarGuardando(conexion);
  }
}

main(process.argv.slice(2)).then(
  (codigo) => process.exit(codigo),
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
);
