'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const agenda = require('../src/agenda.js');
const agente = require('../src/agente.js');
const guardas = require('../src/guardas.js');
const { cargarConfig } = require('../src/config.js');
const { ModeloAuth, ModeloNoDisponible } = require('../src/modelo/errores.js');
const { respuesta, clienteGuion, clienteInfinito } = require('./ayudas.js');

const AHORA = new Date(2026, 10, 3, 10, 42);
const CONFIG = cargarConfig({ RECEPCIONISTA_API_KEY: 'clave-falsa', RECEPCIONISTA_BASE_URL: 'https://modelo.example/v1' });
const HISTORIAL = [{ rol: 'paciente', texto: 'Necesito un turno con cardiología' }];

function slotLibre() {
  return agenda.buscarDisponibilidad(
    { especialidad: 'cardiologia', profesional: null, desde: '2026-11-03', hasta: null, franja: 'cualquiera' },
    { turnos: [], gestion: {}, ahora: AHORA },
  ).slots[0];
}

function atender(cliente, extra = {}) {
  return agente.atenderTurno({
    cliente,
    historial: HISTORIAL,
    agenda: { turnos: [], gestion: {} },
    ahora: AHORA,
    config: CONFIG,
    ...extra,
  });
}

test('bucle completo: buscar y proponer reservar en dos herramientas', async () => {
  const slot = slotLibre();
  const cliente = clienteGuion([
    respuesta({
      herramienta: {
        name: 'buscar_disponibilidad',
        input: { especialidad: 'cardiologia', profesional: null, desde: '2026-11-03', hasta: null, franja: 'cualquiera' },
      },
    }),
    respuesta({ herramienta: { name: 'proponer_reserva', input: { slot_id: slot.slot_id } } }),
    respuesta({ texto: 'Te dejo la tarjeta para que confirmes.' }),
  ]);

  const r = await atender(cliente);

  assert.equal(r.modo, 'ia');
  assert.equal(r.respuesta, 'Te dejo la tarjeta para que confirmes.');
  assert.equal(r.llamadas, 3);
  assert.equal(r.traza.length, 2);
  assert.deepEqual(r.traza.map((t) => t.herramienta), ['buscar_disponibilidad', 'proponer_reserva']);
  assert.ok(r.traza.every((t) => t.ok === true));
  assert.equal(r.acciones.length, 1);
  assert.equal(r.acciones[0].tipo, 'reservar');
  assert.equal(r.acciones[0].slot.fecha, slot.fecha);
  assert.equal(r.acciones[0].slot.hora, slot.hora);
  assert.equal(r.tokens.entrada, 3000);
  assert.ok(r.usd > 0);
  assert.equal(cliente.capturas.length, 3);
});

test('resultados: todos juntos en un solo mensaje, en orden', async () => {
  const cliente = clienteGuion([
    {
      ...respuesta({ texto: 'Busco y derivo.' }),
      llamadas: [
        { id: 'toolu_1', nombre: 'buscar_disponibilidad', entrada: { especialidad: 'clinica' } },
        { id: 'toolu_2', nombre: 'derivar_a_recepcion', entrada: { motivo: 'administrativo', resumen: 'Consulta por facturación.' } },
      ],
      fin: 'herramientas',
      fin_crudo: 'herramientas',
    },
    respuesta({ texto: 'Listo.' }),
  ]);

  const r = await atender(cliente);
  assert.equal(r.modo, 'ia');

  const segundoPedido = cliente.capturas[1];
  const ultimo = segundoPedido.mensajes[segundoPedido.mensajes.length - 1];
  assert.equal(ultimo.rol, 'resultados');
  assert.ok(Array.isArray(ultimo.resultados));
  assert.equal(ultimo.resultados.length, 2);
  assert.deepEqual(ultimo.resultados.map((x) => x.id), ['toolu_1', 'toolu_2']);
  // El mensaje anterior del asistente conserva las llamadas para cerrar el ciclo.
  const asistente = segundoPedido.mensajes[segundoPedido.mensajes.length - 2];
  assert.equal(asistente.rol, 'asistente');
  assert.equal(asistente.llamadas.length, 2);});

test('tope de llamadas: se corta a las 4 y responde en modo respaldo', async () => {
  const cliente = clienteInfinito('buscar_disponibilidad', {
    especialidad: 'clinica',
    profesional: null,
    desde: '2026-11-03',
    hasta: null,
    franja: 'cualquiera',
  });

  const r = await atender(cliente);
  assert.equal(cliente.capturas.length, 4);
  assert.equal(r.modo, 'respaldo');
  assert.equal(r.error, 'limite_llamadas');
  assert.match(r.respuesta, /no está disponible/i);
});

test('fin rechazo y limite caen a respaldo', async () => {
  const rechazo = await atender(clienteGuion([respuesta({ texto: 'No puedo.', fin: 'rechazo' })]));
  assert.equal(rechazo.modo, 'respaldo');
  assert.equal(rechazo.stopReason, 'rechazo');
  assert.match(rechazo.respuesta, /no está disponible/i);

  const limite = await atender(clienteGuion([respuesta({ texto: 'Cortado', fin: 'limite' })]));
  assert.equal(limite.modo, 'respaldo');
  assert.equal(limite.stopReason, 'limite');
});

test('errores del cliente: respaldo con la clasificación, sin filtrar el mensaje', async () => {
  class RateLimitError extends Error {}

  const casos = [
    [new ModeloAuth(), 'auth'],
    [new ModeloNoDisponible(), 'no_disponible'],
    [new RateLimitError('detalle interno del servicio'), 'RateLimitError'],
  ];
  for (const [error, esperado] of casos) {
    const r = await atender(clienteGuion([respuesta({ texto: 'x' })], { error }));
    assert.equal(r.modo, 'respaldo');
    assert.equal(r.error, esperado);
    assert.ok(!r.respuesta.includes('detalle interno'), 'no se filtra el mensaje del error');
  }
  assert.equal(agente.clasificarError(new Error('otro')), 'Error');
  assert.equal(agente.clasificarError(null), 'Error');
});

test('contexto: va solo en el último mensaje y el prompt del sistema no lo lleva', async () => {
  const cliente = clienteGuion([respuesta({ texto: 'Hola.' })]);
  await agente.atenderTurno({
    cliente,
    historial: [
      { rol: 'paciente', texto: 'Hola' },
      { rol: 'asistente', texto: '¿Qué necesitás?' },
      { rol: 'paciente', texto: 'Un turno' },
    ],
    agenda: { turnos: [], gestion: {} },
    ahora: AHORA,
    config: CONFIG,
  });

  const pedido = cliente.capturas[0];
  assert.equal(typeof pedido.sistema, 'string');
  assert.ok(!pedido.sistema.includes('martes 3 de noviembre'), 'el prompt del sistema no lleva la fecha');

  const conContexto = pedido.mensajes.filter((m) => m.texto.includes('<contexto>'));
  assert.equal(conContexto.length, 1);
  assert.equal(pedido.mensajes[pedido.mensajes.length - 1], conContexto[0]);
  assert.equal(pedido.mensajes[0].texto, 'Hola');

  const contexto = conContexto[0].texto;
  assert.match(contexto, /Fecha y hora actual: martes 3 de noviembre de 2026, 10:42 \(America\/Argentina\/Buenos_Aires\)/);
  assert.match(contexto, /Turnos del paciente en este dispositivo: Ninguno/);
});

test('contexto: lista los turnos propios sin datos personales', async () => {
  const cliente = clienteGuion([respuesta({ texto: 'Ok.' })]);
  await agente.atenderTurno({
    cliente,
    historial: HISTORIAL,
    agenda: {
      turnos: [
        { codigo: 'RS-AB12', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web' },
        { codigo: 'RS-CD34', profId: 'sosa', fecha: '2026-11-10', hora: '08:00', origen: 'whatsapp' },
      ],
      gestion: {},
    },
    ahora: AHORA,
    config: CONFIG,
  });
  const contexto = cliente.capturas[0].mensajes.at(-1).texto;
  assert.match(contexto, /RS-AB12 · Cardiología · Dr\. Ricardo Sosa · jueves 5 de noviembre 15:20/);
  assert.ok(!contexto.includes('RS-CD34'), 'los turnos de recepción no son del paciente');
});

test('privacidad: nombre, DNI, celular y obra social de la agenda no llegan al modelo', async () => {
  const cliente = clienteGuion([respuesta({ texto: 'Ok.' })]);
  await agente.atenderTurno({
    cliente,
    historial: HISTORIAL,
    agenda: {
      turnos: [{
        codigo: 'RS-AB12',
        profId: 'sosa',
        fecha: '2026-11-05',
        hora: '15:20',
        origen: 'web',
        paciente: 'Juan Pérez',
        dni: '30111222',
        celular: '2984123456',
        obra: 'OSDE',
        notas: 'Llamar antes',
      }],
      gestion: { 'sosa|2026-11-05|15:20': { cancelado: false, notas: 'privado' } },
    },
    ahora: AHORA,
    config: CONFIG,
  });

  const enviado = JSON.stringify(cliente.capturas[0].mensajes);
  for (const dato of ['Juan Pérez', '30111222', '2984123456', 'OSDE', 'Llamar antes']) {
    assert.ok(!enviado.includes(dato), `no debería viajar "${dato}"`);
  }
  assert.match(cliente.capturas[0].mensajes.at(-1).texto, /RS-AB12/);
});

test('entrada inválida de herramienta: vuelve como resultado con error y no ejecuta nada', async () => {
  const cliente = clienteGuion([
    respuesta({ herramienta: { name: 'proponer_reserva', input: { slot_id: 'no-es-un-slot' } } }),
    respuesta({ texto: 'Necesito que elijas un horario.' }),
  ]);

  const r = await atender(cliente);
  assert.equal(r.acciones.length, 0);
  assert.equal(r.traza[0].ok, false);

  const resultado = cliente.capturas[1].mensajes.at(-1).resultados[0];
  assert.equal(resultado.error, true);
  assert.match(JSON.parse(resultado.contenido).error, /slot_id/);
});

test('ejecutarHerramienta: herramienta desconocida también es un error', () => {
  const salida = agente.ejecutarHerramienta(
    { id: 'toolu_x', nombre: 'borrar_agenda', entrada: {} },
    { turnos: [], gestion: {}, ahora: AHORA },
    [],
    [],
  );
  assert.equal(salida.error, true);
  assert.match(JSON.parse(salida.contenido).error, /desconocida/i);
});

test('respuesta vacía y usage ausente: respaldo sin romper', async () => {
  const vacia = await atender(clienteGuion([respuesta({ texto: '' })]));
  assert.equal(vacia.modo, 'respaldo');
  assert.equal(vacia.error, 'respuesta_vacia');

  const sinUso = await atender(clienteGuion([{ ...respuesta({ texto: 'Hola' }), uso: undefined }]));
  assert.equal(sinUso.modo, 'ia');
  assert.equal(sinUso.usd, 0);
  assert.deepEqual(sinUso.tokens, { entrada: 0, salida: 0, cache_w: 0, cache_r: 0 });
});

test('historial inválido: respaldo sin llamar al modelo', async () => {
  const cliente = clienteGuion([respuesta({ texto: 'x' })]);
  const r = await agente.atenderTurno({
    cliente,
    historial: [{ rol: 'asistente', texto: 'Hola' }],
    agenda: { turnos: [], gestion: {} },
    ahora: AHORA,
    config: CONFIG,
  });
  assert.equal(cliente.capturas.length, 0);
  assert.equal(r.modo, 'respaldo');
  assert.equal(r.error, 'historial_invalido');
});

test('construirMensajes: une roles consecutivos y descarta el primer turno del asistente', () => {
  const mensajes = agente.construirMensajes([
    { rol: 'asistente', texto: 'Hola' },
    { rol: 'paciente', texto: 'Buenas' },
    { rol: 'paciente', texto: 'Necesito un turno' },
    { rol: 'asistente', texto: '¿De qué especialidad?' },
    { rol: 'paciente', texto: 'Cardiología' },
  ], { ahora: AHORA, turnos: [] });

  // Formato neutral: el cliente de modelo lo traduce a su API.
  assert.deepEqual(mensajes.map((m) => m.rol), ['usuario', 'asistente', 'usuario']);
  assert.ok(mensajes[0].texto.includes('Buenas\nNecesito un turno'));
  assert.ok(mensajes[2].texto.includes('Cardiología'));
  assert.match(mensajes[2].texto, /^<contexto>/);
});

test('el agente sanea la agenda aunque el servidor no lo haya hecho', () => {
  const saneada = guardas.sanearAgenda({
    turnos: [{ codigo: 'RS-AB12', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web', dni: '30111222' }],
  });
  assert.equal(saneada.ok, true);
  assert.deepEqual(Object.keys(saneada.turnos[0]).sort(), ['codigo', 'fecha', 'hora', 'origen', 'profId']);
});
