'use strict';

/**
 * Servidor HTTP del recepcionista virtual.
 *
 * `node:http` puro, sin framework. Rutas:
 *   POST /api/recepcionista/chat   conversación
 *   GET  /api/recepcionista/salud  estado del servicio
 *   GET  /*                        estáticos de desarrollo (opcional)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { cargarConfig } = require('./config.js');
const guardas = require('./guardas.js');
const red = require('./red.js');
const { atenderTurno } = require('./agente.js');
const { crearRegistro } = require('./registro.js');
const modeloModulo = require('./modelo/index.js');
const { tokensTotales } = require('./precios.js');
const respaldo = require('./respaldo.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Cliente de modelo del servidor. Se crea una sola vez y se reutiliza en todos
 * los pedidos: el cliente compatible con OpenAI usa `fetch` nativo.
 */
function crearClienteDelServidor(config, opciones = {}) {
  return modeloModulo.resolverCliente({
    cliente: opciones.cliente,
    config,
    opciones: { ahora: opciones.ahora, fetch: opciones.fetch, esperar: opciones.esperar },
  });
}

/**
 * IP real del cliente: `X-Real-IP` solo vale si la conexión viene de un proxy
 * confiable (`RECEPCIONISTA_PROXIES_CONFIABLES`, por defecto loopback) y la
 * cabecera contiene una IP válida. Si no, manda la IP del socket.
 */
function ipDelCliente(req, proxies = red.PROXIES_POR_DEFECTO) {
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  if (!red.esProxyConfiable(socketIp, proxies)) return socketIp;
  const cabecera = req.headers && req.headers['x-real-ip'];
  const candidata = typeof cabecera === 'string' ? cabecera.trim() : '';
  return red.normalizarIp(candidata) || socketIp;
}

function leerCuerpo(req, maximo) {
  return new Promise((resolver, rechazar) => {
    let total = 0;
    let excedido = false;
    const partes = [];
    req.on('data', (trozo) => {
      if (excedido) return;
      total += trozo.length;
      if (total > maximo) {
        excedido = true;
        partes.length = 0;
        rechazar(Object.assign(new Error('cuerpo_grande'), { codigo: 'cuerpo_grande' }));
        return;
      }
      partes.push(trozo);
    });
    req.on('end', () => resolver(Buffer.concat(partes).toString('utf8')));
    req.on('error', rechazar);
  });
}

function json(res, estado, cuerpo, extra = {}) {
  const datos = Buffer.from(JSON.stringify(cuerpo), 'utf8');
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': datos.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(datos);
}

/**
 * Crea el servidor. Todo lo pesado (cliente de modelo, presupuesto, límites) se
 * inyecta para poder probarlo sin red.
 */
function crearServidor(opciones = {}) {
  const config = opciones.config || cargarConfig();
  const reloj = opciones.ahora || (() => new Date());
  const cliente = crearClienteDelServidor(config, { ...opciones, ahora: reloj });
  const proxiesConfiables = red.compilarProxies(config.proxiesConfiables);

  const limitador = guardas.crearLimitador({
    porMinuto: config.porMinuto,
    porDia: config.porDia,
    ahora: reloj,
  });
  const presupuesto = guardas.crearPresupuesto({
    dir: config.datos,
    topeUsdMes: config.topeUsdMes,
    topeTokensDia: config.topeTokensDia,
    ahora: reloj,
  });
  const semaforo = guardas.crearSemaforo(config.concurrencia);
  const registro = crearRegistro({ dir: config.datos, sal: config.sal, ahora: reloj });

  function aplicarCors(req, res) {
    const origen = req.headers.origin;
    if (origen && config.origenes.includes(origen)) {
      res.setHeader('access-control-allow-origin', origen);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
    }
  }

  async function responderChat(req, res, origen) {
    const inicio = Date.now();
    const ip = ipDelCliente(req, proxiesConfiables);

    let crudo;
    try {
      crudo = await leerCuerpo(req, config.maxBytesCuerpo);
    } catch (error) {
      if (error && error.codigo === 'cuerpo_grande') {
        return json(res, 413, { error: 'El pedido es demasiado grande (máximo 32 KB).' }, { connection: 'close' });
      }
      return json(res, 400, { error: 'No se pudo leer el pedido.' });
    }

    let cuerpo;
    try {
      cuerpo = JSON.parse(crudo || '{}');
    } catch {
      return json(res, 400, { error: 'El cuerpo no es JSON válido.' });
    }
    if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
      return json(res, 400, { error: 'El cuerpo tiene que ser un objeto JSON.' });
    }

    const historial = guardas.sanearHistorial(cuerpo.historial, {
      maxMensajes: config.maxMensajesHistorial,
      maxLargoTexto: config.maxLargoTexto,
      maxLargoUltimoTexto: config.maxLargoUltimoTexto,
    });
    if (!historial.ok) return json(res, 400, { error: historial.error });

    const agenda = guardas.sanearAgenda(cuerpo.agenda, {
      maxTurnos: config.maxTurnosAgenda,
      maxGestion: config.maxEntradasGestion,
    });
    if (!agenda.ok) return json(res, 400, { error: agenda.error });

    const limite = limitador.permitir(ip);
    if (!limite.ok) {
      return json(res, 429, {
        error: 'Demasiados pedidos. Probá de nuevo en unos segundos.',
        reintentar_en_s: limite.reintentarEn,
      });
    }

    const ahora = reloj();
    const base = {
      historial: historial.historial,
      agenda: { turnos: agenda.turnos, gestion: agenda.gestion },
      ahora,
    };

    // Modo respaldo sin gastar: sin clave (o simulado apagado) o tope agotado.
    if (!config.iaDisponible || !presupuesto.disponible()) {
      const r = respaldo.respuestaDeRespaldo({
        historial: historial.historial,
        turnos: agenda.turnos,
        gestion: agenda.gestion,
        ahora,
      });
      const ms = Date.now() - inicio;
      registro.escribir({
        ipHash: registro.hashIp(ip),
        modelo: config.modelo,
        modo: 'respaldo',
        ms,
        llamadas: 0,
        herramientas: [],
        tokens: { entrada: 0, salida: 0, cache_w: 0, cache_r: 0 },
        usd: 0,
        stopReason: null,
        error: config.iaDisponible ? 'presupuesto_agotado' : 'sin_clave',
      });
      return json(res, 200, {
        respuesta: r.respuesta,
        acciones: r.acciones,
        traza: [],
        modo: 'respaldo',
        ms,
      });
    }

    const liberar = await semaforo.adquirir();
    if (!liberar) {
      return json(res, 503, {
        error: 'El asistente está atendiendo varios pedidos. Probá de nuevo en unos segundos.',
        reintentar_en_s: 5,
      });
    }

    let resultado;
    try {
      resultado = await atenderTurno({ cliente, ...base, config });
    } catch (error) {
      resultado = {
        respuesta: respaldo.textoDeRespaldo('es'),
        acciones: respaldo.respuestaDeRespaldo(base).acciones,
        traza: [],
        modo: 'respaldo',
        llamadas: 0,
        tokens: { entrada: 0, salida: 0, cache_w: 0, cache_r: 0 },
        usd: 0,
        stopReason: null,
        error: (error && error.constructor && error.constructor.name) || 'Error',
      };
    } finally {
      liberar();
    }

    if (resultado.usd > 0 || tokensTotales(resultado.tokens) > 0) {
      presupuesto.sumar(resultado.usd, tokensTotales(resultado.tokens));
    }

    const ms = Date.now() - inicio;
    registro.escribir({
      ipHash: registro.hashIp(ip),
      modelo: config.modelo,
      modo: resultado.modo,
      ms,
      llamadas: resultado.llamadas,
      herramientas: resultado.traza.map((t) => t.herramienta),
      tokens: resultado.tokens,
      usd: resultado.usd,
      stopReason: resultado.stopReason,
      error: resultado.error,
    });

    void origen;
    return json(res, 200, {
      respuesta: resultado.respuesta,
      acciones: resultado.acciones,
      traza: resultado.traza,
      modo: resultado.modo,
      ms,
    });
  }

  function servirEstatico(req, res, ruta) {
    if (!config.estaticos) return json(res, 404, { error: 'Ruta desconocida.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Método no permitido.' });
    }
    let relativa;
    try {
      relativa = decodeURIComponent(ruta);
    } catch {
      return json(res, 400, { error: 'Ruta inválida.' });
    }
    if (relativa.includes('\0') || relativa.split('/').some((p) => p === '..')) {
      return json(res, 403, { error: 'Ruta inválida.' });
    }
    const destino = path.resolve(config.estaticos, `.${relativa.endsWith('/') ? `${relativa}index.html` : relativa}`);
    const raiz = path.resolve(config.estaticos);
    if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
      return json(res, 403, { error: 'Ruta inválida.' });
    }

    fs.stat(destino, (error, stats) => {
      if (error || !stats.isFile()) return json(res, 404, { error: 'Archivo no encontrado.' });
      const tipo = MIME[path.extname(destino).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': tipo,
        'content-length': stats.size,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const flujo = fs.createReadStream(destino);
      flujo.on('error', () => res.destroy());
      return flujo.pipe(res);
    });
    return undefined;
  }

  const servidor = http.createServer((req, res) => {
    aplicarCors(req, res);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'Pedido inválido.' });
    }
    const ruta = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    if (ruta === '/api/recepcionista/chat') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' });
      return responderChat(req, res, req.headers.origin).catch(() => {
        if (!res.headersSent) json(res, 500, { error: 'Error interno.' });
        else res.destroy();
      });
    }

    if (ruta === '/api/recepcionista/salud') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'Método no permitido.' });
      }
      return json(res, 200, {
        ok: true,
        modelo: config.modelo,
        ia_disponible: config.iaDisponible,
        presupuesto_mes_pct: presupuesto.porcentaje(),
        tokens_dia_pct: presupuesto.porcentajeTokens(),
      });
    }

    if (ruta.startsWith('/api/')) return json(res, 404, { error: 'Ruta desconocida.' });

    return servirEstatico(req, res, ruta);
  });

  servidor.config = config;
  servidor.cliente = cliente;
  servidor.presupuesto = presupuesto;
  servidor.limitador = limitador;
  servidor.semaforo = semaforo;
  servidor.registro = registro;

  return servidor;
}

function arrancar() {
  const config = cargarConfig();
  const servidor = crearServidor({ config });
  servidor.listen(config.puerto, () => {
    const estado = config.iaDisponible
      ? `modelo ${config.modelo}`
      : 'sin clave: modo respaldo';
    console.log(`[recepcionista] escuchando en http://127.0.0.1:${config.puerto} (${estado})`);
  });
  const cerrar = () => servidor.close(() => process.exit(0));
  process.on('SIGTERM', cerrar);
  process.on('SIGINT', cerrar);
}

if (require.main === module) arrancar();

module.exports = { crearServidor, ipDelCliente, arrancar, MIME };
