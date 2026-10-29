'use strict';

/**
 * Configuración del recepcionista virtual.
 *
 * Toda la configuración entra por variables de entorno (ver `.env.example`).
 * `cargarConfig` es pura: recibe el entorno y devuelve un objeto congelado, así
 * las pruebas pueden construir configuraciones sin tocar `process.env`.
 *
 * El cliente de modelo habla la API compatible con OpenAI
 * (`POST ${base}/chat/completions`) con `deepseek-v4.1-flash` por defecto; el
 * valor `simulado` activa el modelo offline, sin red ni clave.
 */

const path = require('node:path');
const crypto = require('node:crypto');

const { PROXIES_POR_DEFECTO } = require('./red.js');

const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
const MODELO_POR_DEFECTO = 'deepseek-v4.1-flash';
const MODELO_SIMULADO = 'simulado';

/** El turnero usa hora local: sin TZ explícita todo se corre a Buenos Aires. */
function forzarZonaHoraria() {
  if (!process.env.TZ) process.env.TZ = ZONA_HORARIA;
}

function numero(valor, porDefecto, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(valor);
  if (valor === undefined || valor === null || valor === '' || !Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

function texto(valor, porDefecto) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : porDefecto;
}

/** Lista separada por comas, sin espacios ni entradas vacías. */
function listaSeparadaPorComas(valor) {
  return String(valor || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function cargarConfig(env = process.env) {
  const modelo = texto(env.RECEPCIONISTA_MODELO, '') || MODELO_POR_DEFECTO;
  const simulado = modelo === MODELO_SIMULADO;
  const baseUrl = texto(env.RECEPCIONISTA_BASE_URL, '');
  const apiKey = texto(env.RECEPCIONISTA_API_KEY, '');

  const datos = path.resolve(texto(env.RECEPCIONISTA_DATOS, './data'));
  const estaticos = texto(env.RECEPCIONISTA_ESTATICOS, '');
  const sal = texto(env.RECEPCIONISTA_SAL, '') || crypto.randomBytes(16).toString('hex');
  const precioEntrada = numero(env.RECEPCIONISTA_PRECIO_ENTRADA, 0.05, { min: 0 });
  const precioSalida = numero(env.RECEPCIONISTA_PRECIO_SALIDA, 0.5, { min: 0 });

  return Object.freeze({
    modelo,
    baseUrl,
    simulado,
    apiKey,
    iaDisponible: simulado || (apiKey !== '' && baseUrl !== ''),
    puerto: numero(env.RECEPCIONISTA_PUERTO, 8790, { min: 0, max: 65535 }),
    topeUsdMes: numero(env.RECEPCIONISTA_TOPE_USD_MES, 0.5, { min: 0 }),
    topeTokensDia: numero(env.RECEPCIONISTA_TOPE_TOKENS_DIA, 3_000_000, { min: 0 }),
    // Precios (USD por millón) para estimar el costo de cada respuesta.
    precioEntrada,
    precioSalida,
    precios: Object.freeze({
      entrada: precioEntrada,
      salida: precioSalida,
      cache_w: 0,
      cache_r: precioEntrada,
    }),
    porMinuto: numero(env.RECEPCIONISTA_POR_MINUTO, 8, { min: 1 }),
    porDia: numero(env.RECEPCIONISTA_POR_DIA, 60, { min: 1 }),
    concurrencia: numero(env.RECEPCIONISTA_CONCURRENCIA, 4, { min: 1, max: 32 }),
    // Sin la variable, ningún origen cruzado: el frontend se sirve del mismo sitio.
    origenes: env.RECEPCIONISTA_ORIGENES === undefined
      ? []
      : listaSeparadaPorComas(env.RECEPCIONISTA_ORIGENES),
    // Proxies cuyo `X-Real-IP` se acepta. Sin la variable, solo loopback; con la
    // variable vacía, ninguno. Las entradas mal formadas se descartan al compilar.
    proxiesConfiables: env.RECEPCIONISTA_PROXIES_CONFIABLES === undefined
      ? [...PROXIES_POR_DEFECTO]
      : listaSeparadaPorComas(env.RECEPCIONISTA_PROXIES_CONFIABLES),
    datos,
    sal,
    estaticos: estaticos ? path.resolve(estaticos) : null,
    zonaHoraria: ZONA_HORARIA,
    // Límites de la conversación: el navegador manda el historial visible.
    maxMensajesHistorial: 12,
    maxLargoTexto: 600,
    maxLargoUltimoTexto: 500,
    maxTokensSalida: 2048,
    maxLlamadasPorTurno: 4,
    maxBytesCuerpo: 32 * 1024,
    maxTurnosAgenda: 300,
    maxEntradasGestion: 300,
  });
}

forzarZonaHoraria();

module.exports = {
  cargarConfig,
  forzarZonaHoraria,
  ZONA_HORARIA,
  MODELO_POR_DEFECTO,
  MODELO_SIMULADO,
};
