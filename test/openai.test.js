'use strict';

/**
 * Cliente de modelo compatible con OpenAI, sin red: `fetch` falso inyectado.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cargarConfig } = require('../src/config.js');
const agente = require('../src/agente.js');
const {
  crearModelo,
  ESPERA_REINTENTO_MS,
  MAX_TOKENS_SALIDA,
} = require('../src/modelo/openai.js');
const { ModeloAuth, ModeloNoDisponible } = require('../src/modelo/errores.js');

const AHORA = new Date(2026, 10, 3, 10, 42);
const CLAVE = 'clave-de-prueba-no-real';
const CONFIG = cargarConfig({
  RECEPCIONISTA_API_KEY: CLAVE,
  RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1',
});

/** Respuesta con la forma de Chat Completions. */
function cuerpoChat({ texto = null, toolCalls = null, finish = 'stop', usage, reasoning } = {}) {
  const mensaje = { role: 'assistant', content: texto };
  if (toolCalls) mensaje.tool_calls = toolCalls;
  if (reasoning) mensaje.reasoning_content = reasoning;
  return {
    id: 'chatcmpl-prueba',
    object: 'chat.completion',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, message: mensaje, finish_reason: finish }],
    usage: usage || { prompt_tokens: 1200, completion_tokens: 80 },
  };
}

function llamadaCruda(id, nombre, argumentos) {
  return { id, type: 'function', function: { name: nombre, arguments: argumentos } };
}

function http(cuerpo, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
  };
}

/** `fetch` falso: devuelve los guiones en orden y guarda cada pedido. */
function fetchGuion(respuestas) {
  const pedidos = [];
  let i = 0;
  const falso = async (url, init) => {
    pedidos.push({ url, init, cuerpo: JSON.parse(init.body) });
    const respuesta = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return typeof respuesta === 'function' ? respuesta() : respuesta;
  };
  return { fetch: falso, pedidos };
}

function crear({ respuestas, config = CONFIG } = {}) {
  const falso = fetchGuion(respuestas);
  const esperas = [];
  const modelo = crearModelo({
    config,
    fetch: falso.fetch,
    esperar: async (ms) => { esperas.push(ms); },
  });
  return { modelo, pedidos: falso.pedidos, esperas };
}

const HERRAMIENTAS = [{
  name: 'buscar_disponibilidad',
  description: 'Busca horarios.',
  strict: true,
  input_schema: { type: 'object', properties: { especialidad: { type: 'string' } }, required: ['especialidad'], additionalProperties: false },
}];

test('cuerpo: system primero, tools en formato function, tool_choice auto y max_tokens 2048', async () => {
  const { modelo, pedidos } = crear({ respuestas: [http(cuerpoChat({ texto: 'Hola.' }))] });

  await modelo.completar({
    sistema: 'Sos la recepcionista.',
    herramientas: HERRAMIENTAS,
    mensajes: [{ rol: 'usuario', texto: 'Hola' }],
  });

  assert.equal(pedidos.length, 1);
  const { url, init, cuerpo } = pedidos[0];
  assert.equal(url, 'https://modelo.example/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${CLAVE}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal, 'timeout con AbortController');
  assert.equal(init.signal.constructor.name, 'AbortSignal');

  assert.deepEqual(cuerpo.messages[0], { role: 'system', content: 'Sos la recepcionista.' });
  assert.deepEqual(cuerpo.messages[1], { role: 'user', content: 'Hola' });
  assert.equal(cuerpo.model, 'deepseek-v4.1-flash');
  assert.equal(cuerpo.max_tokens, MAX_TOKENS_SALIDA);
  assert.equal(cuerpo.tool_choice, 'auto');
  assert.deepEqual(cuerpo.tools[0], {
    type: 'function',
    function: {
      name: 'buscar_disponibilidad',
      description: 'Busca horarios.',
      parameters: HERRAMIENTAS[0].input_schema,
    },
  });
});

test('tool_calls: argumentos como string JSON se parsean a la entrada neutral', async () => {
  const { modelo } = crear({
    respuestas: [http(cuerpoChat({
      finish: 'tool_calls',
      toolCalls: [llamadaCruda('call_1', 'buscar_disponibilidad', '{"especialidad":"cardiologia"}')],
      usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 300 } },
    }))],
  });

  const r = await modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] });

  assert.equal(r.fin, 'herramientas');
  assert.equal(r.fin_crudo, 'tool_calls');
  assert.deepEqual(r.llamadas, [{ id: 'call_1', nombre: 'buscar_disponibilidad', entrada: { especialidad: 'cardiologia' } }]);
  assert.deepEqual(r.uso, { entrada: 900, salida: 40, cache_w: 0, cache_r: 300 });
  assert.equal(r.extra, null);
});

test('argumentos inválidos: la llamada vuelve con error recuperable y se reenvía el texto original', async () => {
  const roto = '{"especialidad": cardiologia';
  const { modelo, pedidos } = crear({
    respuestas: [http(cuerpoChat({
      finish: 'tool_calls',
      toolCalls: [llamadaCruda('call_roto', 'buscar_disponibilidad', roto)],
    }))],
  });

  const mensajes = [{ rol: 'usuario', texto: 'Necesito cardiología' }];
  const r = await modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes });
  assert.equal(r.llamadas[0].error, true);
  assert.match(r.llamadas[0].motivo, /JSON válido/);
  assert.equal(r.llamadas[0].entrada_cruda, roto);

  // Al reenviar el turno, el asistente conserva exactamente el texto que produjo.
  await modelo.completar({
    sistema: 's',
    herramientas: HERRAMIENTAS,
    mensajes: [
      ...mensajes,
      { rol: 'asistente', texto: '', llamadas: r.llamadas, extra: r.extra },
      { rol: 'resultados', resultados: [{ id: 'call_roto', contenido: '{"error":"JSON inválido"}', error: true }] },
    ],
  });
  const segundo = pedidos[1].cuerpo.messages;
  assert.deepEqual(segundo.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(segundo[2].tool_calls[0].function.arguments, roto);
});

test('resultados de herramientas: un mensaje tool por resultado, en orden', async () => {
  const { modelo, pedidos } = crear({ respuestas: [http(cuerpoChat({ texto: 'Ok.' }))] });

  await modelo.completar({
    sistema: 's',
    herramientas: HERRAMIENTAS,
    mensajes: [
      { rol: 'usuario', texto: 'Hola' },
      { rol: 'asistente', texto: '', llamadas: [{ id: 'a', nombre: 'buscar_disponibilidad', entrada: { especialidad: 'cardiologia' } }] },
      {
        rol: 'resultados',
        resultados: [
          { id: 'a', contenido: { slots: [] }, error: false },
          { id: 'b', contenido: '{"error":"ocupado"}', error: true },
        ],
      },
    ],
  });

  const mensajes = pedidos[0].cuerpo.messages;
  assert.deepEqual(mensajes.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(mensajes[3], { role: 'tool', tool_call_id: 'a', content: '{"slots":[]}' });
  assert.deepEqual(mensajes[4], { role: 'tool', tool_call_id: 'b', content: '{"error":"ocupado"}' });
});

test('reasoning_content: se guarda en extra y solo viaja en ese mensaje del asistente', async () => {
  const { modelo, pedidos } = crear({
    respuestas: [http(cuerpoChat({
      finish: 'tool_calls',
      reasoning: 'Pienso qué herramienta usar.',
      toolCalls: [llamadaCruda('call_1', 'buscar_disponibilidad', '{"especialidad":"cardiologia"}')],
    }))],
  });

  const r = await modelo.completar({
    sistema: 's',
    herramientas: HERRAMIENTAS,
    mensajes: [{ rol: 'usuario', texto: 'Necesito cardiología' }],
  });
  assert.deepEqual(r.extra, { reasoning_content: 'Pienso qué herramienta usar.' });

  await modelo.completar({
    sistema: 's',
    herramientas: HERRAMIENTAS,
    mensajes: [
      { rol: 'usuario', texto: 'Necesito cardiología' },
      { rol: 'asistente', texto: '', llamadas: r.llamadas, extra: r.extra },
      { rol: 'resultados', resultados: [{ id: 'call_1', contenido: '{}', error: false }] },
    ],
  });

  const mensajes = pedidos[1].cuerpo.messages;
  const conRazonamiento = mensajes.filter((m) => 'reasoning_content' in m);
  assert.equal(conRazonamiento.length, 1);
  assert.equal(conRazonamiento[0].role, 'assistant');
  assert.equal(conRazonamiento[0].reasoning_content, 'Pienso qué herramienta usar.');
});

test('finish_reason: mapeo a fin neutral', async () => {
  const casos = [
    ['tool_calls', [], 'herramientas'],
    ['stop', [], 'fin'],
    ['length', [], 'limite'],
    ['content_filter', [], 'rechazo'],
    [null, [], 'fin'],
  ];
  for (const [finish, toolCalls, esperado] of casos) {
    const { modelo } = crear({ respuestas: [http(cuerpoChat({ texto: 'x', finish, toolCalls: toolCalls.length ? toolCalls : null }))] });
    const r = await modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] });
    assert.equal(r.fin, esperado, `finish_reason ${finish}`);
  }
});

test('429: reintenta una vez a los 1,5 s y sigue si el servicio responde', async () => {
  const { modelo, pedidos, esperas } = crear({
    respuestas: [
      http({ error: { message: 'rate limited' } }, { status: 429, ok: false }),
      http(cuerpoChat({ texto: 'Ahora sí.' })),
    ],
  });

  const r = await modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] });
  assert.equal(r.texto, 'Ahora sí.');
  assert.equal(pedidos.length, 2);
  assert.deepEqual(esperas, [ESPERA_REINTENTO_MS]);
  assert.equal(ESPERA_REINTENTO_MS, 1500);
});

test('503 dos veces: error tipado y el agente responde en modo respaldo', async () => {
  const { modelo, pedidos } = crear({
    respuestas: [http('{"error":"over capacity"}', { status: 503, ok: false })],
  });

  await assert.rejects(
    () => modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloNoDisponible,
  );
  assert.equal(pedidos.length, 2, 'un solo reintento');

  const r = await agente.atenderTurno({
    cliente: modelo,
    historial: [{ rol: 'paciente', texto: 'Necesito un turno' }],
    agenda: { turnos: [], gestion: {} },
    ahora: AHORA,
    config: CONFIG,
  });
  assert.equal(r.modo, 'respaldo');
  assert.equal(r.error, 'no_disponible');
  assert.match(r.respuesta, /no está disponible/i);
});

test('401: error de credencial sin reintento y log "auth"', async () => {
  const { modelo, pedidos, esperas } = crear({
    respuestas: [http({ error: { message: `invalid key ${CLAVE}` } }, { status: 401, ok: false })],
  });

  await assert.rejects(
    () => modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloAuth,
  );
  assert.equal(pedidos.length, 1);
  assert.deepEqual(esperas, []);

  const r = await agente.atenderTurno({
    cliente: modelo,
    historial: [{ rol: 'paciente', texto: 'Necesito un turno' }],
    agenda: { turnos: [], gestion: {} },
    ahora: AHORA,
    config: CONFIG,
  });
  assert.equal(r.modo, 'respaldo');
  assert.equal(r.error, 'auth');
});

test('la clave no aparece en logs, en errores ni en el cuerpo del registro', async () => {
  const registros = [];
  const originales = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => registros.push(args.join(' '));
  console.error = (...args) => registros.push(args.join(' '));
  console.warn = (...args) => registros.push(args.join(' '));

  try {
    const { modelo } = crear({
      respuestas: [http({ error: { message: `incorrect api key ${CLAVE}` } }, { status: 401, ok: false })],
    });

    let capturado = null;
    try {
      await modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] });
    } catch (error) {
      capturado = error;
    }

    assert.ok(capturado instanceof ModeloAuth);
    assert.ok(!String(capturado.message).includes(CLAVE));
    assert.ok(!String(capturado.stack).includes(CLAVE));

    const r = await agente.atenderTurno({
      cliente: modelo,
      historial: [{ rol: 'paciente', texto: 'Hola' }],
      agenda: { turnos: [], gestion: {} },
      ahora: AHORA,
      config: CONFIG,
    });
    assert.ok(!JSON.stringify(r).includes(CLAVE));
    assert.deepEqual(registros.filter((linea) => linea.includes(CLAVE)), []);
  } finally {
    console.log = originales.log;
    console.error = originales.error;
    console.warn = originales.warn;
  }
});

test('sin URL base o sin clave: error tipado, nunca una excepción cruda', async () => {
  const sinClave = crearModelo({
    config: { ...CONFIG, apiKey: '', modelo: 'deepseek-v4.1-flash' },
    fetch: async () => { throw new Error('no debería llamarse'); },
  });
  await assert.rejects(
    () => sinClave.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloNoDisponible,
  );

  const sinBase = crearModelo({
    config: { ...CONFIG, baseUrl: '', modelo: 'deepseek-v4.1-flash' },
    fetch: async () => { throw new Error('no debería llamarse'); },
  });
  await assert.rejects(
    () => sinBase.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloNoDisponible,
  );
});

test('red caída y respuesta ilegible: ModeloNoDisponible sin filtrar detalles', async () => {
  const caido = crear({ respuestas: [async () => { throw new Error('ECONNREFUSED con detalles'); }] });
  await assert.rejects(
    () => caido.modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloNoDisponible
      && !/ECONNREFUSED/.test(error.message),
  );

  const ilegible = crear({ respuestas: [http('<html>no es json</html>')] });
  await assert.rejects(
    () => ilegible.modelo.completar({ sistema: 's', herramientas: HERRAMIENTAS, mensajes: [{ rol: 'usuario', texto: 'x' }] }),
    (error) => error instanceof ModeloNoDisponible,
  );
});
