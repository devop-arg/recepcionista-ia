'use strict';

/**
 * Configuración por defecto, límites y precios.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cargarConfig } = require('../src/config.js');
const { costoDe } = require('../src/precios.js');

test('por defecto: deepseek-v4.1-flash, sin URL base, sin clave y en modo respaldo', () => {
  const config = cargarConfig({});
  assert.equal(config.modelo, 'deepseek-v4.1-flash');
  assert.equal(config.baseUrl, '');
  assert.equal(config.apiKey, '');
  assert.equal(config.simulado, false);
  assert.equal(config.iaDisponible, false, 'sin clave arranca en modo respaldo');
  assert.equal(config.topeTokensDia, 3_000_000);
  assert.equal(config.topeUsdMes, 0.5);
  assert.equal(config.precioEntrada, 0.05);
  assert.equal(config.precioSalida, 0.5);
  assert.deepEqual(config.precios, { entrada: 0.05, salida: 0.5, cache_w: 0, cache_r: 0.05 });
  assert.deepEqual(config.origenes, [], 'sin la variable no hay orígenes permitidos');
  assert.equal(config.puerto, 8790);
});

test('RECEPCIONISTA_MODELO=simulado activa el simulador sin clave ni red', () => {
  const config = cargarConfig({ RECEPCIONISTA_MODELO: 'simulado' });
  assert.equal(config.modelo, 'simulado');
  assert.equal(config.simulado, true);
  assert.equal(config.iaDisponible, true);
});

test('ia_disponible: exige clave y URL base, salvo en modo simulado', () => {
  const completo = cargarConfig({
    RECEPCIONISTA_API_KEY: 'clave',
    RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1',
  });
  assert.equal(completo.iaDisponible, true);

  assert.equal(cargarConfig({ RECEPCIONISTA_API_KEY: 'clave' }).iaDisponible, false, 'falta la URL base');
  assert.equal(cargarConfig({ RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1' }).iaDisponible, false, 'falta la clave');
});

test('el modelo y los precios se pueden pisar', () => {
  const config = cargarConfig({
    RECEPCIONISTA_MODELO: 'otro-modelo',
    RECEPCIONISTA_API_KEY: 'clave',
    RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1',
    RECEPCIONISTA_PRECIO_ENTRADA: '1',
    RECEPCIONISTA_PRECIO_SALIDA: '2',
  });
  assert.equal(config.modelo, 'otro-modelo');
  assert.equal(costoDe({ entrada: 1e6 }, config.precios), 1);
  assert.equal(costoDe({ salida: 1e6 }, config.precios), 2);
  // Sin fila propia para el modelo: mandan los precios de la configuración.
  assert.equal(costoDe({ entrada: 1e6, salida: 1e6 }, config.precios), 3);
});

test('tope mensual y diario de tokens: valores y corte en cero', () => {
  const config = cargarConfig({
    RECEPCIONISTA_TOPE_USD_MES: '2.25',
    RECEPCIONISTA_TOPE_TOKENS_DIA: '1000',
  });
  assert.equal(config.topeUsdMes, 2.25);
  assert.equal(config.topeTokensDia, 1000);

  const cero = cargarConfig({ RECEPCIONISTA_TOPE_USD_MES: '0', RECEPCIONISTA_TOPE_TOKENS_DIA: '0' });
  assert.equal(cero.topeUsdMes, 0);
  assert.equal(cero.topeTokensDia, 0);

  const invalido = cargarConfig({ RECEPCIONISTA_TOPE_USD_MES: 'no-es-numero' });
  assert.equal(invalido.topeUsdMes, 0.5, 'un valor inválido cae al default');
});

test('orígenes CORS y proxies confiables: lista, vacío y default', () => {
  assert.deepEqual(cargarConfig({}).origenes, []);
  assert.deepEqual(cargarConfig({ RECEPCIONISTA_ORIGENES: '' }).origenes, []);
  assert.deepEqual(
    cargarConfig({ RECEPCIONISTA_ORIGENES: 'https://example.com, https://otro.example' }).origenes,
    ['https://example.com', 'https://otro.example'],
  );

  assert.deepEqual(cargarConfig({}).proxiesConfiables, ['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  assert.deepEqual(cargarConfig({ RECEPCIONISTA_PROXIES_CONFIABLES: '' }).proxiesConfiables, []);
});
