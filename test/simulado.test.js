'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const agente = require('../src/agente.js');
const { crearModeloSimulado, USO_FIJO, sinContexto } = require('../src/modelo/simulado.js');
const { cargarConfig } = require('../src/config.js');

const AHORA = new Date(2026, 10, 3, 10, 42);
const CONFIG = cargarConfig({ RECEPCIONISTA_MODELO: 'simulado' });

function turnoWeb() {
  return { codigo: 'RS-AB12', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web' };
}

async function conversar(texto, { agenda = { turnos: [], gestion: {} } } = {}) {
  const cliente = crearModeloSimulado({ ahora: () => AHORA });
  const r = await agente.atenderTurno({
    cliente,
    historial: [{ rol: 'paciente', texto }],
    agenda,
    ahora: AHORA,
    config: CONFIG,
  });
  return { r, cliente };
}

test('simulado: pide el turno de la especialidad nombrada', async () => {
  const { r } = await conversar('Necesito un turno con cardiología');
  assert.equal(r.modo, 'ia');
  assert.equal(r.acciones.length, 1);
  assert.equal(r.acciones[0].tipo, 'reservar');
  assert.equal(r.acciones[0].slot.espId, 'cardiologia');
  assert.match(r.respuesta, /Confirmalo en la tarjeta/);
  assert.deepEqual(r.traza.map((t) => t.herramienta), ['buscar_disponibilidad', 'proponer_reserva']);
});

test('simulado: cancela el primer código del contexto', async () => {
  const { r, cliente } = await conversar('cancelá mi turno', { agenda: { turnos: [turnoWeb()], gestion: {} } });
  assert.equal(r.modo, 'ia');
  assert.equal(r.acciones.length, 1);
  assert.equal(r.acciones[0].tipo, 'cancelar');
  assert.equal(r.acciones[0].codigo, 'RS-AB12');
  assert.match(cliente.pedidos[0].mensajes.at(-1).texto, /RS-AB12/);
});

test('simulado: urgencia deriva y nombra el 107 y el 911', async () => {
  const { r } = await conversar('tengo dolor de pecho');
  assert.equal(r.acciones[0].tipo, 'derivar');
  assert.equal(r.acciones[0].motivo, 'urgencia');
  assert.match(r.respuesta, /107/);
  assert.match(r.respuesta, /911/);
});

test('simulado: urgencia con "falta de aire" también deriva', async () => {
  const { r } = await conversar('estoy con falta de aire y mareos');
  assert.equal(r.acciones[0].tipo, 'derivar');
  assert.equal(r.acciones[0].motivo, 'urgencia');
});

test('simulado: receta va a recepción', async () => {
  const { r } = await conversar('necesito que me renueven la receta');
  assert.equal(r.acciones[0].tipo, 'derivar');
  assert.equal(r.acciones[0].motivo, 'consulta_medica');
});

test('simulado: sin especialidad pregunta cuál necesita', async () => {
  const { r } = await conversar('hola, buenas tardes');
  assert.equal(r.acciones.length, 0);
  assert.match(r.respuesta, /especialidad/i);
});

test('simulado: cancelar sin turnos guardados no inventa códigos', async () => {
  const { r } = await conversar('quiero cancelar mi turno');
  assert.equal(r.acciones.length, 0);
  assert.match(r.respuesta, /No veo turnos guardados/);
});

test('simulado: implementa la interfaz neutral, sin red ni clave', async () => {
  const cliente = crearModeloSimulado({ ahora: () => AHORA });
  const respuesta = await cliente.completar({
    sistema: 'sos la recepcionista',
    herramientas: [],
    mensajes: [{ rol: 'usuario', texto: 'Hola' }],
  });

  assert.equal(typeof respuesta.texto, 'string');
  assert.ok(Array.isArray(respuesta.llamadas));
  assert.equal(respuesta.fin, 'fin');
  assert.deepEqual(respuesta.uso, USO_FIJO);
  assert.equal(respuesta.extra, null);
  assert.equal(cliente.pedidos.length, 1);
});

test('simulado: sinContexto limpia el contexto del turno', () => {
  const limpio = sinContexto(
    '<contexto>\nFecha y hora actual: martes 3 de noviembre de 2026, 10:42 (America/Argentina/Buenos_Aires)\n'
    + 'Turnos del paciente en este dispositivo: Ninguno\n</contexto>\n\nHola, necesito un turno',
  );
  assert.equal(limpio, 'Hola, necesito un turno');
});
