'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../vendor/turnero.js');
const herramientas = require('../src/herramientas.js');

const AHORA = new Date(2026, 10, 3, 10, 42);
const VACIO = { turnos: [], gestion: {}, ahora: AHORA };

test('definiciones: nombre, descripción, strict y additionalProperties: false', () => {
  assert.equal(herramientas.HERRAMIENTAS.length, 5);
  const nombres = new Set();
  for (const definicion of herramientas.HERRAMIENTAS) {
    assert.equal(definicion.strict, true, `${definicion.name} debe ser strict`);
    assert.ok(definicion.name && !nombres.has(definicion.name), 'nombres únicos');
    nombres.add(definicion.name);
    assert.ok(typeof definicion.description === 'string' && definicion.description.length > 20);

    const esquema = definicion.input_schema;
    assert.equal(esquema.type, 'object');
    assert.equal(esquema.additionalProperties, false, `${definicion.name}: additionalProperties false`);

    const propiedades = Object.keys(esquema.properties);
    assert.deepEqual(
      [...esquema.required].sort(),
      propiedades.sort(),
      `${definicion.name}: todos los campos tienen que estar en required`,
    );
  }
  assert.deepEqual(
    herramientas.HERRAMIENTAS.map((h) => h.name),
    ['buscar_disponibilidad', 'proponer_reserva', 'proponer_cancelacion', 'proponer_reprogramacion', 'derivar_a_recepcion'],
  );
});

test('buscar_disponibilidad: el enum de especialidades sale del turnero', () => {
  const def = herramientas.HERRAMIENTAS[0];
  assert.deepEqual(def.input_schema.properties.especialidad.enum, RS.ESPECIALIDADES.map((e) => e.id));
  assert.deepEqual(def.input_schema.properties.franja.enum, ['manana', 'tarde', 'cualquiera']);
  assert.equal(def.input_schema.properties.profesional.anyOf[1].type, 'null');
});

test('validador: rechaza especialidad, fechas, franja, profesional y campos extra', () => {
  const base = {
    especialidad: 'cardiologia',
    profesional: null,
    desde: '2026-11-03',
    hasta: null,
    franja: 'cualquiera',
  };
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', base).ok, true);

  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, especialidad: 'kinesiologia' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, desde: '03/11/2026' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, desde: '2026-02-31' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, hasta: '2026-11-01' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, franja: 'noche' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, profesional: 'Dr. Sosa' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', { ...base, dni: '30111222' }).ok, false);
  assert.equal(herramientas.validarEntrada('buscar_disponibilidad', null).ok, false);

  const errores = herramientas.validarEntrada('buscar_disponibilidad', { ...base, franja: 'noche' }).errores;
  assert.ok(errores.some((e) => /franja/.test(e)));
});

test('validador: códigos, slots y derivaciones', () => {
  assert.equal(herramientas.validarEntrada('proponer_cancelacion', { codigo: 'RS-AB12' }).ok, true);
  assert.equal(herramientas.validarEntrada('proponer_cancelacion', { codigo: 'AB12' }).ok, false);
  assert.equal(herramientas.validarEntrada('proponer_cancelacion', { codigo: 'RS-AB12', dni: '1' }).ok, false);

  assert.equal(herramientas.validarEntrada('proponer_reserva', { slot_id: 'sosa|2026-11-05|08:00' }).ok, true);
  assert.equal(herramientas.validarEntrada('proponer_reserva', { slot_id: 'sosa-2026-11-05-08:00' }).ok, false);
  assert.equal(herramientas.validarEntrada('proponer_reserva', { slot_id: 'sosa|2026-11-05|25:00' }).ok, false);

  assert.equal(herramientas.validarEntrada('derivar_a_recepcion', { motivo: 'urgencia', resumen: 'Dolor de pecho.' }).ok, true);
  assert.equal(herramientas.validarEntrada('derivar_a_recepcion', { motivo: 'urgente', resumen: 'x' }).ok, false);
  assert.equal(herramientas.validarEntrada('derivar_a_recepcion', { motivo: 'otro', resumen: 'a'.repeat(201) }).ok, false);
  assert.equal(herramientas.validarEntrada('derivar_a_recepcion', { motivo: 'otro', resumen: '   ' }).ok, false);

  assert.equal(herramientas.validarEntrada('inventada', {}).ok, false);
});

test('despacho: buscar_disponibilidad devuelve slots reales o motivo', () => {
  const r = herramientas.despachar('buscar_disponibilidad', {
    especialidad: 'cardiologia',
    profesional: null,
    desde: '2026-11-03',
    hasta: null,
    franja: 'cualquiera',
  }, VACIO);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.resultado.slots) && r.resultado.slots.length > 0);

  const vacio = herramientas.despachar('buscar_disponibilidad', {
    especialidad: 'cardiologia',
    profesional: null,
    desde: '2026-11-04',
    hasta: '2026-11-04',
    franja: 'cualquiera',
  }, VACIO);
  assert.deepEqual(vacio.resultado.slots, []);
  assert.ok(vacio.resultado.motivo);
});

test('despacho: reservar y cancelar devuelven acciones, no escrituras', () => {
  const slot = herramientas.despachar('buscar_disponibilidad', {
    especialidad: 'dermatologia',
    profesional: null,
    desde: '2026-11-03',
    hasta: null,
    franja: 'cualquiera',
  }, VACIO).resultado.slots[0];

  const reserva = herramientas.despachar('proponer_reserva', { slot_id: slot.slot_id }, VACIO);
  assert.equal(reserva.ok, true);
  assert.equal(reserva.accion.tipo, 'reservar');
  assert.match(reserva.resultado.resumen, /Dermatología/);

  const ctx = {
    ahora: AHORA,
    gestion: {},
    turnos: [{ codigo: 'RS-AB12', profId: 'gimenez', fecha: '2026-11-05', hora: '08:00', origen: 'web' }],
  };
  const cancelacion = herramientas.despachar('proponer_cancelacion', { codigo: 'RS-AB12' }, ctx);
  assert.equal(cancelacion.ok, true);
  assert.deepEqual(cancelacion.accion.tipo, 'cancelar');
  assert.equal(cancelacion.accion.codigo, 'RS-AB12');

  const sinTurno = herramientas.despachar('proponer_cancelacion', { codigo: 'RS-ZZZZ' }, ctx);
  assert.equal(sinTurno.ok, false);
  assert.ok(sinTurno.resultado.motivo);
});

test('despacho: derivar a recepción', () => {
  const r = herramientas.despachar('derivar_a_recepcion', { motivo: 'urgencia', resumen: 'Dolor de pecho.' }, VACIO);
  assert.equal(r.ok, true);
  assert.deepEqual(r.accion, { tipo: 'derivar', motivo: 'urgencia', resumen: 'Dolor de pecho.' });
});

test('acciones: si se repite el tipo, queda la última', () => {
  const acciones = [];
  herramientas.acumularAccion(acciones, { tipo: 'reservar', slot: { hora: '08:00' } });
  herramientas.acumularAccion(acciones, { tipo: 'cancelar', codigo: 'RS-AB12' });
  herramientas.acumularAccion(acciones, { tipo: 'reservar', slot: { hora: '09:00' } });
  assert.equal(acciones.length, 2);
  assert.equal(acciones.find((a) => a.tipo === 'reservar').slot.hora, '09:00');
  assert.equal(acciones.find((a) => a.tipo === 'cancelar').codigo, 'RS-AB12');
});
