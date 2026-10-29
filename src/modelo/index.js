'use strict';

/**
 * Fábrica del cliente de modelo.
 *
 * El agente solo conoce esta interfaz:
 *
 *   completar({ sistema, herramientas, mensajes })
 *     → { texto, llamadas: [{ id, nombre, entrada }], fin, uso, extra, crudo }
 *
 * `fin` es 'herramientas' | 'fin' | 'rechazo' | 'limite' y `uso` viene con
 * `{ entrada, salida, cache_w, cache_r }`.
 */

const { crearModelo } = require('./openai.js');
const { crearModeloSimulado } = require('./simulado.js');

/**
 * Crea el cliente que pide la configuración: el simulado cuando
 * `RECEPCIONISTA_MODELO=simulado`, o el cliente compatible con OpenAI.
 * `opciones` permite inyectar `fetch`, el reloj y la espera entre reintentos,
 * así las pruebas corren sin red ni esperas reales.
 */
function crearCliente(config = {}, opciones = {}) {
  if (config.simulado) {
    return crearModeloSimulado({
      ahora: opciones.ahora || (() => new Date()),
      uso: opciones.uso,
    });
  }
  return crearModelo({
    config,
    fetch: opciones.fetch,
    esperar: opciones.esperar,
  });
}

/** Devuelve el cliente inyectado o crea el que corresponde a la configuración. */
function resolverCliente({ cliente, config = {}, opciones = {} } = {}) {
  if (cliente) return cliente;
  return crearCliente(config, opciones);
}

module.exports = { crearCliente, resolverCliente };
