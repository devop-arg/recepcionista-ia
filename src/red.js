'use strict';

/**
 * Decisión de confianza sobre la IP del socket.
 *
 * `X-Real-IP` solo vale si la conexión viene de un proxy conocido (nginx en
 * loopback, o el gateway de Docker en bridge). La lista de proxies confiables
 * sale de `RECEPCIONISTA_PROXIES_CONFIABLES`: IPs exactas o CIDR IPv4 separados
 * por coma. El CIDR se resuelve a mano para no sumar dependencias.
 *
 * Una entrada mal formada se descarta: si la lista queda vacía nadie es
 * confiable, nunca "todos".
 */

const net = require('node:net');

const PROXIES_POR_DEFECTO = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** IPv4 estricta: cuatro octetos decimales de 0 a 255, sin ceros a la izquierda. */
function parsearIpv4(texto) {
  if (typeof texto !== 'string') return null;
  const partes = texto.split('.');
  if (partes.length !== 4) return null;
  let valor = 0;
  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte)) return null;
    if (parte.length > 1 && parte[0] === '0') return null;
    const octeto = Number(parte);
    if (octeto > 255) return null;
    valor = valor * 256 + octeto;
  }
  return valor >>> 0;
}

function formatearIpv4(valor) {
  return [24, 16, 8, 0].map((desplazamiento) => (valor >>> desplazamiento) & 0xff).join('.');
}

/**
 * Normaliza una dirección de socket o de cabecera: IPv4 canónica, IPv4 mapeada
 * en IPv6 (`::ffff:a.b.c.d`) pasada a IPv4, IPv6 en minúsculas. `null` si no es
 * una IP válida.
 */
function normalizarIp(ip) {
  if (typeof ip !== 'string') return null;
  const texto = ip.trim();
  if (!texto) return null;

  const mapeada = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(texto);
  if (mapeada) {
    const valor = parsearIpv4(mapeada[1]);
    return valor === null ? null : formatearIpv4(valor);
  }

  const valor = parsearIpv4(texto);
  if (valor !== null) return formatearIpv4(valor);

  if (net.isIP(texto) === 6) return texto.toLowerCase();
  return null;
}

function esRegla(valor) {
  return valor !== null
    && typeof valor === 'object'
    && (valor.tipo === 'ip' || valor.tipo === 'cidr');
}

/**
 * Compila la lista de proxies confiables. Acepta un array o el texto separado
 * por comas tal como llega del entorno. Las entradas inválidas se ignoran.
 */
function compilarProxies(entradas) {
  const lista = Array.isArray(entradas) ? entradas : String(entradas === undefined || entradas === null ? '' : entradas).split(',');
  const reglas = [];

  for (const cruda of lista) {
    if (typeof cruda !== 'string') continue;
    const texto = cruda.trim();
    if (!texto) continue;

    const barra = texto.indexOf('/');
    if (barra === -1) {
      const ip = normalizarIp(texto);
      if (ip !== null) reglas.push(Object.freeze({ tipo: 'ip', ip }));
      continue;
    }

    if (texto.indexOf('/', barra + 1) !== -1) continue;

    const textoBase = texto.slice(0, barra).trim();
    const textoBits = texto.slice(barra + 1).trim();
    if (!/^\d{1,2}$/.test(textoBits)) continue;

    const bits = Number(textoBits);
    if (bits > 32) continue;

    // Solo CIDR IPv4: una base IPv6 con `/` no se interpreta.
    const base = parsearIpv4(textoBase);
    if (base === null) continue;

    const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    reglas.push(Object.freeze({
      tipo: 'cidr',
      base: (base & mascara) >>> 0,
      bits,
      mascara,
    }));
  }

  return Object.freeze(reglas);
}

/**
 * `true` solo si la IP del socket cae en la lista de proxies confiables.
 * `proxies` puede ser el texto del entorno, un array de entradas o el resultado
 * de `compilarProxies`.
 */
function esProxyConfiable(ipSocket, proxies = PROXIES_POR_DEFECTO) {
  const reglas = Array.isArray(proxies) && proxies.every(esRegla)
    ? proxies
    : compilarProxies(proxies);
  if (reglas.length === 0) return false;

  const ip = normalizarIp(ipSocket);
  if (ip === null) return false;

  const valor = parsearIpv4(ip);
  for (const regla of reglas) {
    if (regla.tipo === 'ip') {
      if (regla.ip === ip) return true;
      continue;
    }
    if (valor === null) continue;
    if (((valor & regla.mascara) >>> 0) === regla.base) return true;
  }
  return false;
}

module.exports = {
  PROXIES_POR_DEFECTO,
  normalizarIp,
  compilarProxies,
  esProxyConfiable,
};
