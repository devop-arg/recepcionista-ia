'use strict';

/**
 * Capa de modelo: precio por tokens, fábrica y equivalencia entre el cliente
 * real (sin red, con `fetch` inyectado) y el simulado.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const agenda = require('../src/agenda.js');
const agente = require('../src/agente.js');
const { cargarConfig } = require('../src/config.js');
const { crearCliente, resolverCliente } = require('../src/modelo/index.js');
const { crearModelo } = require('../src/modelo/openai.js');
const { crearModeloSimulado } = require('../src/modelo/simulado.js');
const { costoDe, tokensDe, tokensTotales, sumarUso } = require('../src/precios.js');

const AHORA = new Date(2026, 10, 3, 10, 42);
const HISTORIAL = [{ rol: 'paciente', texto: 'Necesito un turno con cardiología' }];
const AGENDA = { turnos: [], gestion: {} };

function slotLibre() {
  return agenda.buscarDisponibilidad(
    { especialidad: 'cardiologia', profesional: null, desde: '2026-11-03', hasta: null, franja: 'cualquiera' },
    { turnos: [], gestion: {}, ahora: AHORA },
  ).slots[0];
}

function http(cuerpo, { status = 200, ok = true } = {}) {
  return { ok, status, text: async () => JSON.stringify(cuerpo) };
}

function chat({ texto = null, toolCalls = null, finish = 'stop' } = {}) {
  const mensaje = { role: 'assistant', content: texto };
  if (toolCalls) mensaje.tool_calls = toolCalls;
  return {
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, message: mensaje, finish_reason: finish }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
}

function herramienta(id, nombre, entrada) {
  return { id, type: 'function', function: { name: nombre, arguments: JSON.stringify(entrada) } };
}

/** Guion de tres respuestas: buscar → proponer → texto. */
function guionOpenAI(slot) {
  return [
    http(chat({
      finish: 'tool_calls',
      toolCalls: [herramienta('call_1', 'buscar_disponibilidad', {
        especialidad: 'cardiologia', profesional: null, desde: '2026-11-03', hasta: null, franja: 'cualquiera',
      })],
    })),
    http(chat({
      finish: 'tool_calls',
      toolCalls: [herramienta('call_2', 'proponer_reserva', { slot_id: slot.slot_id })],
    })),
    http(chat({ texto: 'Te dejo la tarjeta para que confirmes.', finish: 'stop' })),
  ];
}

test('costo: USD por millón de tokens, redondeado a 6 decimales', () => {
  const precios = { entrada: 0.05, salida: 0.5, cache_w: 0, cache_r: 0.05 };

  assert.equal(costoDe({ entrada: 1e6 }, precios), 0.05);
  assert.equal(costoDe({ salida: 1e6 }, precios), 0.5);
  assert.equal(costoDe({ cache_r: 1e6 }, precios), 0.05);
  assert.equal(costoDe({ cache_w: 1e6 }, precios), 0);

  // Sin precios propios se usan los de referencia (0.05 / 0.50).
  assert.equal(costoDe({ entrada: 1e6 }), 0.05);
  assert.equal(costoDe({ salida: 1e6 }), 0.5);

  assert.equal(costoDe({
    entrada: 5400,
    salida: 360,
    cache_w: 0,
    cache_r: 3600,
  }, precios), 0.00063);
});

test('precios: suma de contadores y tolerancia a usage vacío', () => {
  assert.deepEqual(tokensDe({ input_tokens: 10, prompt_tokens: 99 }), {
    entrada: 10, salida: 0, cache_w: 0, cache_r: 0,
  });
  assert.deepEqual(tokensDe({ prompt_tokens: 10, completion_tokens: 5 }), {
    entrada: 10, salida: 5, cache_w: 0, cache_r: 0,
  });
  assert.equal(costoDe(undefined), 0);
  assert.equal(costoDe({}, { entrada: 1, salida: 2 }), 0);
  assert.equal(costoDe({ input_tokens: null, output_tokens: 'x' }), 0);
  assert.deepEqual(sumarUso({ entrada: 1, salida: 2 }, { entrada: 3, cache_r: 4 }), {
    entrada: 4, salida: 2, cache_w: 0, cache_r: 4,
  });
  assert.equal(tokensTotales({ entrada: 10, salida: 5, cache_w: 2, cache_r: 3 }), 20);
});

test('fábrica: el modelo simulado se activa con RECEPCIONISTA_MODELO=simulado', () => {
  const simulado = crearCliente(cargarConfig({ RECEPCIONISTA_MODELO: 'simulado' }), { ahora: () => AHORA });
  assert.equal(simulado.nombre, 'simulado');
  assert.equal(typeof simulado.completar, 'function');

  const real = crearCliente(cargarConfig({
    RECEPCIONISTA_API_KEY: 'clave-falsa',
    RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1',
  }), { fetch: async () => http(chat({ texto: 'x' })) });
  assert.equal(real.nombre, 'openai');
  assert.equal(real.modelo, 'deepseek-v4.1-flash');

  const inyectado = { nombre: 'propio', completar: async () => ({ texto: 'ok' }) };
  assert.equal(resolverCliente({ cliente: inyectado }), inyectado);
  assert.equal(resolverCliente({ config: cargarConfig({ RECEPCIONISTA_MODELO: 'simulado' }) }).nombre, 'simulado');
});

test('el cliente real y el simulado producen las mismas acciones y la misma traza', async () => {
  const slot = slotLibre();

  const configSimulado = cargarConfig({ RECEPCIONISTA_MODELO: 'simulado' });
  const simulado = await agente.atenderTurno({
    cliente: crearModeloSimulado({ ahora: () => AHORA }),
    historial: HISTORIAL,
    agenda: AGENDA,
    ahora: AHORA,
    config: configSimulado,
  });

  const pedidos = [];
  const configReal = cargarConfig({
    RECEPCIONISTA_API_KEY: 'clave-falsa',
    RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1',
  });
  const real = crearModelo({
    config: configReal,
    fetch: async (url, init) => {
      pedidos.push(JSON.parse(init.body));
      return guionOpenAI(slot)[pedidos.length - 1];
    },
    esperar: async () => {},
  });
  const realResultado = await agente.atenderTurno({
    cliente: real,
    historial: HISTORIAL,
    agenda: AGENDA,
    ahora: AHORA,
    config: configReal,
  });

  for (const [nombre, r] of [['simulado', simulado], ['openai', realResultado]]) {
    assert.equal(r.modo, 'ia', nombre);
    assert.equal(r.llamadas, 3, nombre);
    assert.deepEqual(r.traza.map((t) => t.herramienta), ['buscar_disponibilidad', 'proponer_reserva'], nombre);
    assert.ok(r.traza.every((t) => t.ok === true), nombre);
    assert.equal(r.acciones.length, 1, nombre);
    assert.equal(r.acciones[0].tipo, 'reservar', nombre);
    assert.ok(r.tokens.entrada > 0, nombre);
    assert.ok(r.usd > 0, nombre);
  }

  // Mismas acciones para el paciente, aunque el texto lo redacte cada modelo.
  assert.deepEqual(simulado.acciones, realResultado.acciones);

  // El pedido al servicio lleva el system del servidor y las herramientas reales.
  assert.equal(pedidos[0].messages[0].role, 'system');
  assert.equal(pedidos[0].tools.length, 5);
  assert.deepEqual(pedidos[0].tools.map((t) => t.function.name), [
    'buscar_disponibilidad', 'proponer_reserva', 'proponer_cancelacion', 'proponer_reprogramacion', 'derivar_a_recepcion',
  ]);
});

test('el bucle es agnóstico: un cliente mínimo propio también funciona', async () => {
  const slot = slotLibre();
  const guion = [
    { texto: '', llamadas: [{ id: 'x1', nombre: 'proponer_reserva', entrada: { slot_id: slot.slot_id } }], fin: 'herramientas', uso: { entrada: 10, salida: 5, cache_w: 0, cache_r: 0 }, extra: null },
    { texto: 'Listo, confirmá en la tarjeta.', llamadas: [], fin: 'fin', uso: { entrada: 10, salida: 5, cache_w: 0, cache_r: 0 }, extra: null },
  ];
  let i = 0;
  const cliente = {
    nombre: 'propio',
    modelo: 'propio-1',
    completar: async () => guion[Math.min(i, guion.length - 1)] && guion[i++],
  };

  const config = cargarConfig({ RECEPCIONISTA_API_KEY: 'x', RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1' });
  const r = await agente.atenderTurno({
    cliente,
    historial: HISTORIAL,
    agenda: AGENDA,
    ahora: AHORA,
    config,
  });

  assert.equal(r.modo, 'ia');
  assert.equal(r.respuesta, 'Listo, confirmá en la tarjeta.');
  assert.equal(r.acciones[0].tipo, 'reservar');
  assert.equal(r.tokens.entrada, 20);
});
