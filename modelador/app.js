// Modelador BPMN 2.0 basado en bpmn-js (el motor de bpmn.io y Camunda Modeler).
//
// Funciona en dos modos:
//  - local: servido por scripts/servidor-modelador.mjs. Lista diagramas/ y los
//    diagramas que Claude está construyendo (.bpmn-mcp/), se actualiza en vivo
//    y guarda en diagramas/.
//  - en línea (GitHub Pages u otro hosting estático): lista los diagramas del
//    repositorio en GitHub; se pueden editar y descargar.
//
// Parámetros de la URL:
//   ?archivo=diagramas/x.bpmn   abre un diagrama del proyecto/repositorio
//   ?rama=mi-rama               (en línea) rama de GitHub de la que leer
//   ?repo=dueño/repositorio     (en línea) repositorio de GitHub
//   ?url=https://...            abre un .bpmn desde cualquier URL con CORS
//
// scripts/pagina-modelador.mjs genera además una copia de un solo archivo con
// bpmn-js y el diagrama incrustados (window.DIAGRAMA_INCRUSTADO).

const VERSION_BPMN_JS = '18.31.0';
const FUENTES_BPMN_JS = ['vendor/bpmn-js', `https://unpkg.com/bpmn-js@${VERSION_BPMN_JS}/dist`];

const DIAGRAMA_NUEVO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const $ = (id) => document.getElementById(id);
const parametros = new URLSearchParams(location.search);
const INCRUSTADO = window.DIAGRAMA_INCRUSTADO ?? null;

const estado = {
  modo: 'en-linea', // 'local' | 'en-linea' | 'incrustado'
  camunda: false,
  repo: null, // { dueno, nombre, rama } en modo en línea
  lista: [],
  actual: null, // { origen, archivo, nombre, url }
  xmlCargado: null, // XML tal como se cargó o guardó la última vez
  sucio: false,
  pendiente: null, // versión de Claude que llegó con cambios sin guardar
  vistaAjustada: null, // encuadre que pusimos nosotros (si sigue igual, re-encuadramos)
};

let modelador;
let importando = false;

// ── Utilidades ──────────────────────────────────────────────────────────────

function notificar(texto, { error = false, enlace = null, duracion = 4500 } = {}) {
  const nodo = document.createElement('div');
  nodo.className = `notificacion${error ? ' error' : ''}`;
  nodo.textContent = texto;
  if (enlace) {
    const a = Object.assign(document.createElement('a'), { href: enlace, target: '_blank', rel: 'noopener' });
    a.textContent = ' Abrir ↗';
    nodo.append(a);
  }
  $('notificaciones').append(nodo);
  setTimeout(() => nodo.remove(), enlace ? duracion * 3 : duracion);
}

function intentar(accion) {
  return async (...args) => {
    try {
      await accion(...args);
    } catch (error) {
      console.error(error);
      notificar(error.message, { error: true });
    }
  };
}

function aSlug(texto) {
  return (
    String(texto)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'diagrama'
  );
}

function descargar(contenido, nombreArchivo, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombreArchivo });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pedirTexto(url) {
  const respuesta = await fetch(url, { cache: 'no-store' });
  if (!respuesta.ok) throw new Error(`No se pudo leer ${url} (HTTP ${respuesta.status})`);
  return respuesta.text();
}

const urlApi = (origen, archivo) => `api/diagramas/${origen}/${encodeURIComponent(archivo)}`;

// ── Carga de bpmn-js (local primero, CDN como respaldo) ────────────────────

function cargarScript(src) {
  return new Promise((resolver, rechazar) => {
    const script = Object.assign(document.createElement('script'), { src });
    script.onload = resolver;
    script.onerror = () => {
      script.remove();
      rechazar(new Error(`No se pudo cargar ${src}`));
    };
    document.head.append(script);
  });
}

function cargarEstilos(base) {
  const nuestraHoja = document.querySelector('link[rel="stylesheet"]');
  for (const hoja of ['diagram-js.css', 'bpmn-js.css', 'bpmn-font/css/bpmn-embedded.css']) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${base}/assets/${hoja}` });
    document.head.insertBefore(link, nuestraHoja);
  }
}

async function cargarBpmnJs() {
  if (window.BpmnJS) return; // ya viene incluido en la página
  for (const base of FUENTES_BPMN_JS) {
    try {
      await cargarScript(`${base}/bpmn-modeler.production.min.js`);
      cargarEstilos(base);
      return;
    } catch {
      // probamos la siguiente fuente
    }
  }
  throw new Error('No se pudo cargar bpmn-js. Revisa tu conexión o ejecuta "npm install".');
}

// ── Diagrama actual ─────────────────────────────────────────────────────────

function nombreDelModelo() {
  const raices = modelador.getDefinitions()?.rootElements ?? [];
  const colaboracion = raices.find((r) => r.$type === 'bpmn:Collaboration');
  const proceso = raices.find((r) => r.$type === 'bpmn:Process');
  return proceso?.name || colaboracion?.participants?.find((p) => p.name)?.name || estado.actual?.nombre || 'diagrama';
}

function marcarSucio(sucio) {
  estado.sucio = sucio;
  actualizarTitulo();
}

function actualizarTitulo() {
  const actual = estado.actual;
  const titulo = $('titulo-diagrama');
  if (!actual) {
    titulo.textContent = 'Sin diagrama abierto';
    document.title = 'Modelador BPMN 2.0';
    return;
  }
  const ubicacion = actual.origen === 'mcp' ? 'en construcción por Claude' : actual.archivo ? `diagramas/${actual.archivo}` : '';
  titulo.textContent = `${actual.nombre}${estado.sucio ? ' • sin guardar' : ''}${ubicacion ? ` — ${ubicacion}` : ''}`;
  document.title = `${estado.sucio ? '• ' : ''}${actual.nombre} · Modelador BPMN 2.0`;
}

function mismaVista(a, b) {
  return a && b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1);
}

/** Encuadra el diagrama completo dejando libre la franja de la paleta. */
function encuadrar() {
  const canvas = modelador.get('canvas');
  const { inner: caja } = canvas.viewbox();
  const contenedor = $('lienzo').getBoundingClientRect();
  const paleta = document.querySelector('.djs-palette')?.getBoundingClientRect();
  const margen = 24;
  // En pantallas angostas la paleta se superpone: reservarle espacio encogería demasiado el diagrama.
  const reservarPaleta = paleta?.width && paleta.right - contenedor.left < contenedor.width * 0.2;
  const izquierda = reservarPaleta ? paleta.right - contenedor.left + margen : margen;
  const ancho = Math.max(1, contenedor.width - izquierda - margen);
  const alto = Math.max(1, contenedor.height - 2 * margen);
  if (!caja.width || !caja.height) {
    canvas.zoom('fit-viewport', 'auto');
  } else {
    const escala = Math.min(ancho / caja.width, alto / caja.height, 1);
    canvas.viewbox({
      x: caja.x - (izquierda + (ancho - caja.width * escala) / 2) / escala,
      y: caja.y - (margen + (alto - caja.height * escala) / 2) / escala,
      width: contenedor.width / escala,
      height: contenedor.height / escala,
    });
  }
  estado.vistaAjustada = canvas.viewbox();
}

/**
 * Importa XML en el lienzo. Con `conservarVista`, mantiene el zoom/posición
 * salvo que el usuario no lo haya tocado desde el último encuadre automático
 * (así, mientras Claude dibuja, el diagrama completo sigue a la vista).
 */
async function importar(xml, { conservarVista = false } = {}) {
  const canvas = modelador.get('canvas');
  const vistaPrevia = conservarVista && estado.actual ? canvas.viewbox() : null;
  importando = true;
  try {
    const { warnings } = await modelador.importXML(xml);
    if (warnings?.length) console.warn('Avisos al importar:', warnings);
  } finally {
    importando = false;
  }
  if (vistaPrevia && !mismaVista(vistaPrevia, estado.vistaAjustada)) {
    canvas.viewbox(vistaPrevia);
  } else {
    encuadrar();
  }
  estado.xmlCargado = xml;
  estado.pendiente = null;
  $('aviso').hidden = true;
  $('vacio').hidden = true;
  marcarSucio(false);
}

async function abrir(entrada, opciones = {}) {
  if (estado.sucio && !opciones.forzar && !confirm('Tienes cambios sin guardar. ¿Abrir otro diagrama de todos modos?')) {
    return;
  }
  const xml = await pedirTexto(entrada.url);
  await importar(xml, opciones);
  estado.actual = entrada;
  actualizarTitulo();
  pintarLista();
  recordarEnUrl(entrada);
  $('panel').classList.remove('abierto');
}

function recordarEnUrl(entrada) {
  const nuevos = new URLSearchParams(location.search);
  nuevos.delete('url');
  nuevos.delete('archivo');
  if (entrada.origen === 'diagramas') nuevos.set('archivo', `diagramas/${entrada.archivo}`);
  else if (entrada.origen === 'mcp') nuevos.set('archivo', `.bpmn-mcp/${entrada.archivo}`);
  else if (entrada.url && /^https?:/.test(entrada.url)) nuevos.set('url', entrada.url);
  const consulta = nuevos.toString();
  history.replaceState(null, '', `${location.pathname}${consulta ? `?${consulta}` : ''}`);
}

// ── Lista de diagramas ──────────────────────────────────────────────────────

function detectarRepo() {
  const rama = parametros.get('rama') || 'main';
  const [dueno, nombre] = (parametros.get('repo') || '').split('/');
  if (dueno && nombre) return { dueno, nombre, rama };
  // En GitHub Pages: https://<dueño>.github.io/<repositorio>/
  if (location.hostname.endsWith('.github.io')) {
    const primerSegmento = location.pathname.split('/').filter(Boolean)[0];
    return { dueno: location.hostname.split('.')[0], nombre: primerSegmento || location.hostname, rama };
  }
  return null;
}

async function cargarLista() {
  if (estado.modo === 'incrustado') return [];
  if (estado.modo === 'local') {
    const items = JSON.parse(await pedirTexto('api/diagramas'));
    return items.map((d) => ({ ...d, url: urlApi(d.origen, d.archivo) }));
  }
  if (estado.repo) {
    const { dueno, nombre, rama } = estado.repo;
    try {
      const api = `https://api.github.com/repos/${dueno}/${nombre}/contents/diagramas?ref=${encodeURIComponent(rama)}`;
      const archivos = JSON.parse(await pedirTexto(api));
      return archivos
        .filter((a) => a.type === 'file' && a.name.endsWith('.bpmn'))
        .map((a) => ({ origen: 'diagramas', archivo: a.name, nombre: a.name.replace(/\.bpmn$/, ''), url: a.download_url }));
    } catch (error) {
      console.warn('No se pudo listar desde GitHub, uso el índice publicado:', error);
    }
  }
  try {
    const indice = JSON.parse(await pedirTexto('diagramas/indice.json'));
    return indice.map((d) => ({ origen: 'diagramas', ...d, url: `diagramas/${encodeURIComponent(d.archivo)}` }));
  } catch {
    return [];
  }
}

function hace(ms) {
  const segundos = Math.round((Date.now() - ms) / 1000);
  if (segundos < 60) return 'hace un momento';
  if (segundos < 3600) return `hace ${Math.round(segundos / 60)} min`;
  if (segundos < 86400) return `hace ${Math.round(segundos / 3600)} h`;
  return new Date(ms).toLocaleDateString();
}

function pintarLista() {
  const grupos = { diagramas: $('lista-diagramas'), mcp: $('lista-mcp') };
  for (const [origen, ul] of Object.entries(grupos)) {
    ul.replaceChildren();
    const items = estado.lista.filter((d) => d.origen === origen);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'vacia';
      li.textContent = origen === 'mcp' ? 'Nada en construcción' : 'Aún no hay diagramas';
      ul.append(li);
    }
    for (const entrada of items) {
      const boton = document.createElement('button');
      boton.type = 'button';
      const actual = estado.actual?.origen === entrada.origen && estado.actual?.archivo === entrada.archivo;
      boton.setAttribute('aria-current', String(actual));
      const nombre = Object.assign(document.createElement('span'), { className: 'nombre', textContent: entrada.nombre });
      const detalle = Object.assign(document.createElement('span'), {
        className: 'detalle',
        textContent: entrada.modificado ? `${entrada.archivo} · ${hace(entrada.modificado)}` : entrada.archivo,
      });
      boton.append(nombre, detalle);
      boton.addEventListener('click', intentar(() => abrir(entrada)));
      const li = document.createElement('li');
      li.append(boton);
      ul.append(li);
    }
  }
}

async function refrescarLista() {
  estado.lista = await cargarLista();
  pintarLista();
}

// ── Recarga en vivo (modo local) ────────────────────────────────────────────

async function alCambiar({ origen, archivo, existe }) {
  await refrescarLista();
  if (!existe) return;
  const entrada = estado.lista.find((d) => d.origen === origen && d.archivo === archivo);
  if (!entrada) return;

  const esActual = estado.actual?.origen === origen && estado.actual?.archivo === archivo;
  if (esActual) {
    const xml = await pedirTexto(entrada.url);
    if (xml === estado.xmlCargado) return; // eco de nuestro propio guardado
    if (estado.sucio) {
      estado.pendiente = xml;
      $('aviso').hidden = false;
      return;
    }
    await importar(xml, { conservarVista: true });
    estado.actual = entrada;
    actualizarTitulo();
    return;
  }

  if ($('seguir').checked && !estado.sucio) {
    await abrir(entrada, { forzar: true });
    notificar(`Claude está trabajando en «${entrada.nombre}»`);
  }
}

function conectarEnVivo() {
  const fuente = new EventSource('api/eventos');
  const pill = $('estado');
  fuente.onopen = () => {
    pill.textContent = 'En vivo';
    pill.classList.add('en-vivo');
    pill.title = 'Los cambios que haga Claude aparecen aquí automáticamente';
  };
  fuente.onerror = () => {
    pill.textContent = 'Reconectando…';
    pill.classList.remove('en-vivo');
  };
  fuente.addEventListener('cambio', (evento) => intentar(alCambiar)(JSON.parse(evento.data)));
}

// ── Acciones ────────────────────────────────────────────────────────────────

async function guardar() {
  const { xml } = await modelador.saveXML({ format: true });
  const nombre = nombreDelModelo();
  if (estado.modo !== 'local') {
    descargar(xml, `${aSlug(nombre)}.bpmn`, 'application/xml');
    notificar('En línea no se puede escribir en el repositorio: se descargó el archivo .bpmn.');
    return;
  }

  let archivo = estado.actual?.origen === 'diagramas' ? estado.actual.archivo : null;
  if (!archivo) {
    const elegido = prompt('Nombre del archivo en diagramas/:', `${aSlug(nombre)}.bpmn`);
    if (!elegido) return;
    archivo = elegido.endsWith('.bpmn') ? elegido : `${elegido}.bpmn`;
    const existe = estado.lista.some((d) => d.origen === 'diagramas' && d.archivo === archivo);
    if (existe && !confirm(`diagramas/${archivo} ya existe. ¿Reemplazarlo?`)) return;
  }

  const respuesta = await fetch(urlApi('diagramas', archivo), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  if (!respuesta.ok) throw new Error((await respuesta.json()).error || 'No se pudo guardar');
  estado.xmlCargado = xml;
  estado.actual = { origen: 'diagramas', archivo, nombre, url: urlApi('diagramas', archivo) };
  marcarSucio(false);
  recordarEnUrl(estado.actual);
  await refrescarLista();
  notificar(`Guardado en diagramas/${archivo}`);
}

async function subirACamunda() {
  const { xml } = await modelador.saveXML({ format: true });
  const nombre = estado.actual?.archivo?.replace(/\.bpmn$/, '') || aSlug(nombreDelModelo());
  const boton = $('btn-camunda');
  boton.disabled = true;
  try {
    const respuesta = await fetch('api/camunda/subir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml, nombre }),
    });
    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(datos.error || 'No se pudo subir a Camunda');
    notificar(`Diagrama ${datos.accion} en Camunda.`, { enlace: datos.enlace });
  } finally {
    boton.disabled = false;
  }
}

async function abrirArchivoLocal(archivo) {
  if (!archivo) return;
  if (estado.sucio && !confirm('Tienes cambios sin guardar. ¿Abrir el archivo de todos modos?')) return;
  await importar(await archivo.text());
  estado.actual = { nombre: archivo.name.replace(/\.(bpmn|xml)$/i, '') };
  actualizarTitulo();
  pintarLista();
}

function enlazarInterfaz() {
  $('btn-nuevo').addEventListener(
    'click',
    intentar(async () => {
      if (estado.sucio && !confirm('Tienes cambios sin guardar. ¿Empezar un diagrama nuevo?')) return;
      await importar(DIAGRAMA_NUEVO);
      estado.actual = { nombre: 'Diagrama nuevo' };
      recordarEnUrl(estado.actual);
      actualizarTitulo();
      pintarLista();
    })
  );
  $('btn-abrir').addEventListener('click', () => $('entrada-archivo').click());
  $('entrada-archivo').addEventListener(
    'change',
    intentar(async (evento) => {
      await abrirArchivoLocal(evento.target.files[0]);
      evento.target.value = '';
    })
  );
  $('btn-guardar').addEventListener('click', intentar(guardar));
  $('btn-bpmn').addEventListener(
    'click',
    intentar(async () => {
      const { xml } = await modelador.saveXML({ format: true });
      descargar(xml, `${aSlug(nombreDelModelo())}.bpmn`, 'application/xml');
    })
  );
  $('btn-svg').addEventListener(
    'click',
    intentar(async () => {
      const { svg } = await modelador.saveSVG();
      descargar(svg, `${aSlug(nombreDelModelo())}.svg`, 'image/svg+xml');
    })
  );
  $('btn-camunda').addEventListener('click', intentar(subirACamunda));
  $('btn-ajustar').addEventListener('click', () => encuadrar());
  $('btn-aviso-cargar').addEventListener(
    'click',
    intentar(() => importar(estado.pendiente, { conservarVista: true }))
  );
  $('btn-aviso-ignorar').addEventListener('click', () => {
    estado.pendiente = null;
    $('aviso').hidden = true;
  });
  $('btn-panel').addEventListener('click', () => {
    const abierto = $('panel').classList.toggle('abierto');
    $('btn-panel').setAttribute('aria-expanded', String(abierto));
  });

  // Arrastrar y soltar archivos .bpmn
  let profundidad = 0;
  document.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    profundidad++;
    $('soltar').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    if (--profundidad <= 0) {
      profundidad = 0;
      $('soltar').hidden = true;
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener(
    'drop',
    intentar(async (e) => {
      e.preventDefault();
      profundidad = 0;
      $('soltar').hidden = true;
      await abrirArchivoLocal(e.dataTransfer?.files?.[0]);
    })
  );

  window.addEventListener('beforeunload', (e) => {
    if (estado.sucio) e.preventDefault();
  });
}

// ── Arranque ────────────────────────────────────────────────────────────────

async function detectarModo() {
  if (INCRUSTADO) {
    estado.modo = 'incrustado';
    return;
  }
  // En GitHub Pages no hay servidor local que consultar.
  if (location.hostname.endsWith('.github.io')) {
    estado.repo = detectarRepo();
    return;
  }
  try {
    const respuesta = await fetch('api/estado', { cache: 'no-store' });
    if (respuesta.ok) {
      const datos = await respuesta.json();
      estado.modo = datos.modo;
      estado.camunda = Boolean(datos.camunda);
      return;
    }
  } catch {
    // sin servidor local
  }
  estado.modo = 'en-linea';
  estado.repo = detectarRepo();
}

function entradaInicial() {
  const url = parametros.get('url');
  if (url) return { nombre: decodeURIComponent(url.split('/').pop().replace(/\.bpmn$/, '')), url };

  const ruta = parametros.get('archivo');
  if (!ruta) return null;
  const archivo = ruta.split('/').pop();
  const origen = ruta.startsWith('.bpmn-mcp/') ? 'mcp' : 'diagramas';
  const enLista = estado.lista.find((d) => d.origen === origen && d.archivo === archivo);
  if (enLista) return enLista;
  if (estado.modo === 'local') return { origen, archivo, nombre: archivo.replace(/\.bpmn$/, ''), url: urlApi(origen, archivo) };
  if (estado.repo) {
    const { dueno, nombre, rama } = estado.repo;
    return {
      origen,
      archivo,
      nombre: archivo.replace(/\.bpmn$/, ''),
      url: `https://raw.githubusercontent.com/${dueno}/${nombre}/${rama}/${ruta.split('/').map(encodeURIComponent).join('/')}`,
    };
  }
  return { origen, archivo, nombre: archivo.replace(/\.bpmn$/, ''), url: ruta };
}

async function iniciar() {
  enlazarInterfaz();
  await detectarModo();
  await cargarBpmnJs();
  modelador = new window.BpmnJS({ container: $('lienzo') });
  modelador.on('commandStack.changed', () => {
    if (!importando) marcarSucio(true);
  });

  const pill = $('estado');
  if (estado.modo === 'incrustado') {
    $('panel').hidden = true;
    $('btn-panel').hidden = true;
    $('btn-guardar').hidden = true;
    pill.textContent = 'Copia independiente';
    pill.title = 'Edita y descarga el diagrama; los cambios no se guardan en el proyecto';
    await importar(INCRUSTADO.xml);
    estado.actual = { nombre: INCRUSTADO.nombre };
    actualizarTitulo();
    return;
  }
  if (estado.modo === 'local') {
    $('btn-camunda').hidden = !estado.camunda;
    conectarEnVivo();
  } else {
    $('seccion-mcp').hidden = true;
    $('opcion-seguir').hidden = true;
    $('btn-guardar').hidden = true;
    pill.textContent = estado.repo ? `En línea · rama ${estado.repo.rama}` : 'En línea';
    pill.title = estado.repo ? `Diagramas de github.com/${estado.repo.dueno}/${estado.repo.nombre}` : '';
  }

  await refrescarLista();
  const inicial = entradaInicial() ?? (estado.modo === 'local' || estado.lista.length === 1 ? estado.lista[0] : null);
  if (inicial) await abrir(inicial, { forzar: true });
}

intentar(iniciar)();
