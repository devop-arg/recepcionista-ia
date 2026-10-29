'use strict';

/**
 * Confianza de la IP del socket y uso de `X-Real-IP`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROXIES_POR_DEFECTO,
  normalizarIp,
  compilarProxies,
  esProxyConfiable,
} = require('../src/red.js');
const { cargarConfig } = require('../src/config.js');
const { ipDelCliente } = require('../src/server.js');
const { servidorDePrueba } = require('./ayudas.js');

const HISTORIAL = [{ rol: 'paciente', texto: 'Necesito un turno con cardiología' }];

function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recepcionista-red-'));
}

function pedirChatConIp(base, ip) {
  return fetch(`${base}/api/recepcionista/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-real-ip': ip } : {}) },
    body: JSON.stringify({ historial: HISTORIAL, agenda: {} }),
  });
}

test('proxies: por defecto solo loopback es confiable', () => {
  const config = cargarConfig({});
  assert.deepEqual(config.proxiesConfiables, [...PROXIES_POR_DEFECTO]);

  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(esProxyConfiable(ip, config.proxiesConfiables), true, ip);
  }
  for (const ip of ['10.0.0.1', '203.0.113.7', '::2', '', 'no-es-ip', null]) {
    assert.equal(esProxyConfiable(ip, config.proxiesConfiables), false, String(ip));
  }
  // Sin proxies configurados nadie es confiable (nunca "todos").
  assert.equal(esProxyConfiable('127.0.0.1', []), false);
  assert.equal(esProxyConfiable('127.0.0.1', ''), false);
});

test('proxies: coincidencia exacta y CIDR IPv4 que coincide o no', () => {
  const proxies = compilarProxies('10.0.0.0/8, 172.16.5.0/24, 192.168.1.5');

  assert.equal(esProxyConfiable('10.1.2.3', proxies), true);
  assert.equal(esProxyConfiable('10.255.255.255', proxies), true);
  assert.equal(esProxyConfiable('11.0.0.0', proxies), false);
  assert.equal(esProxyConfiable('9.255.255.255', proxies), false);

  assert.equal(esProxyConfiable('172.16.5.9', proxies), true);
  assert.equal(esProxyConfiable('172.16.6.1', proxies), false);
  assert.equal(esProxyConfiable('172.18.0.1', proxies), false);

  assert.equal(esProxyConfiable('192.168.1.5', proxies), true);
  assert.equal(esProxyConfiable('192.168.1.6', proxies), false);

  // También acepta el texto crudo del entorno.
  assert.equal(esProxyConfiable('172.18.0.1', '172.18.0.0/16'), true);
});

test('proxies: IPv4 mapeada en IPv6 se normaliza a IPv4', () => {
  assert.equal(normalizarIp('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizarIp('::FFFF:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizarIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizarIp('::1'), '::1');
  assert.equal(normalizarIp('basura'), null);
  assert.equal(normalizarIp('::ffff:300.1.2.3'), null);

  assert.equal(esProxyConfiable('::ffff:10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(esProxyConfiable('::ffff:203.0.113.7', '10.0.0.0/8'), false);
  assert.equal(esProxyConfiable('::ffff:127.0.0.1', PROXIES_POR_DEFECTO), true);
});

test('proxies: configuración mal formada se ignora y nunca confía en todos', () => {
  const cruda = 'basura, 300.0.0.0/8, 10.0.0.0/33, 10.0.0.0/8x, 10.0.0.0/, /8, 10.0.0.1234, 1.2.3, , 10.0.0.0/8/9';
  assert.equal(compilarProxies(cruda).length, 0);
  assert.equal(esProxyConfiable('203.0.113.9', cruda), false);
  assert.equal(esProxyConfiable('10.1.2.3', cruda), false);
  assert.equal(esProxyConfiable('127.0.0.1', cruda), false);

  // Una entrada válida sobrevive aunque el resto sea basura.
  const mixta = 'basura, 10.0.0.0/8, 10.0.0.0/99';
  assert.equal(esProxyConfiable('10.9.9.9', mixta), true);
  assert.equal(esProxyConfiable('11.9.9.9', mixta), false);

  // Configuración: la lista se limpia y se conserva tal cual, sin romper.
  assert.deepEqual(cargarConfig({ RECEPCIONISTA_PROXIES_CONFIABLES: ' 127.0.0.1 ,, 10.0.0.0/8 ' }).proxiesConfiables,
    ['127.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(cargarConfig({ RECEPCIONISTA_PROXIES_CONFIABLES: '' }).proxiesConfiables, []);
});

test('ipDelCliente: X-Real-IP solo desde un proxy confiable y solo si es una IP', () => {
  const confiable = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.7' } };
  assert.equal(ipDelCliente(confiable), '203.0.113.7');
  assert.equal(ipDelCliente(confiable, '127.0.0.1'), '203.0.113.7');
  assert.equal(ipDelCliente(confiable, '10.0.0.0/8'), '127.0.0.1', 'socket no confiable: manda el socket');

  const ajeno = { socket: { remoteAddress: '203.0.113.50' }, headers: { 'x-real-ip': '203.0.113.7' } };
  assert.equal(ipDelCliente(ajeno, '127.0.0.1'), '203.0.113.50');
  assert.equal(ipDelCliente(ajeno), '203.0.113.50');

  const cabeceraRota = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-real-ip': 'no-es-ip' } };
  assert.equal(ipDelCliente(cabeceraRota), '::ffff:127.0.0.1');

  const sinCabecera = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.equal(ipDelCliente(sinCabecera), '127.0.0.1');
});

test('server: X-Real-IP ignorada si el socket no es un proxy confiable', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({
    datos,
    porMinuto: 1,
    entorno: { RECEPCIONISTA_PROXIES_CONFIABLES: '10.0.0.0/8' },
  });
  try {
    const primera = await pedirChatConIp(base, '203.0.113.7');
    assert.equal(primera.status, 200);

    // Si la cabecera se respetara, sería otra IP y no habría límite.
    const segunda = await pedirChatConIp(base, '203.0.113.8');
    assert.equal(segunda.status, 429, 'se cuenta la IP del socket (127.0.0.1)');
  } finally {
    await cerrar();
  }
});

test('server: X-Real-IP usada si el socket es un proxy confiable', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({
    datos,
    porMinuto: 1,
    entorno: { RECEPCIONISTA_PROXIES_CONFIABLES: '127.0.0.1' },
  });
  try {
    const primera = await pedirChatConIp(base, '203.0.113.7');
    assert.equal(primera.status, 200);
    const segunda = await pedirChatConIp(base, '203.0.113.8');
    assert.equal(segunda.status, 200, 'cada cabecera es una IP distinta');

    // Y la misma IP repetida sí se limita.
    const tercera = await pedirChatConIp(base, '203.0.113.7');
    assert.equal(tercera.status, 429);
  } finally {
    await cerrar();
  }
});
