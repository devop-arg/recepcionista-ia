'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../vendor/turnero.js');
const agenda = require('../src/agenda.js');
const herramientas = require('../src/herramientas.js');

// Martes 3 de noviembre de 2026, 10:42 (hora local del proceso).
const AHORA = new Date(2026, 10, 3, 10, 42);
const HOY = RS.isoDe(AHORA);
const VACIO = { turnos: [], gestion: {}, ahora: AHORA };

function buscar(entrada, ctx = VACIO) {
  return agenda.buscarDisponibilidad({
    profesional: null,
    hasta: null,
    franja: 'cualquiera',
    ...entrada,
  }, ctx);
}

function primerSlot(especialidad, ctx = VACIO) {
  const r = buscar({ especialidad, desde: RS.isoDe(ctx.ahora) }, ctx);
  assert.ok(r.slots.length > 0, `se esperaban horarios libres de ${especialidad}`);
  return r.slots[0];
}

function ocupar(horas, profId, fecha, origen = 'recepcion') {
  return horas.map((hora, i) => ({
    codigo: `RS-A${String(i).padStart(3, '0')}`,
    profId,
    fecha,
    hora,
    origen,
  }));
}

test('disponibilidad: solo días en los que el profesional atiende', () => {
  const r = buscar({ especialidad: 'cardiologia', desde: HOY });
  assert.ok(r.slots.length > 0);
  assert.ok(r.slots.length <= agenda.MAX_SLOTS);
  for (const slot of r.slots) {
    const partes = agenda.partesDeSlot(slot.slot_id);
    assert.ok(partes, 'slot_id con formato válido');
    const { prof } = RS.profesionalPorId(partes.profId);
    const dow = RS.fechaDeIso(partes.fecha).getDay();
    assert.ok(prof.dias.includes(dow), `${slot.profesional} no atiende el día ${partes.fecha}`);
    assert.equal(slot.especialidad, 'Cardiología');
    assert.equal(slot.profesional, prof.nombre);
    assert.equal(slot.fecha, partes.fecha);
  }
});

test('disponibilidad: reparte los cupos en días distintos antes de repetir', () => {
  const r = buscar({ especialidad: 'clinica', desde: HOY });
  const fechas = r.slots.map((s) => s.fecha);
  assert.equal(new Set(fechas).size, Math.min(fechas.length, r.slots.length));
  // Con 21 días abiertos y horarios de sobra, los 6 cupos caen en 6 días distintos.
  assert.equal(new Set(fechas).size, r.slots.length);
});

test('disponibilidad: no ofrece domingos', () => {
  assert.equal(RS.fechaDeIso('2026-11-08').getDay(), 0);
  const r = buscar({ especialidad: 'dermatologia', desde: '2026-11-08', hasta: '2026-11-08' });
  assert.deepEqual(r.slots, []);
  assert.match(r.motivo, /cerrado/i);
});

test('disponibilidad: no ofrece feriados (23 de noviembre de 2026)', () => {
  assert.equal(RS.esFeriado('2026-11-23'), true);
  const r = buscar({ especialidad: 'clinica', desde: '2026-11-23', hasta: '2026-11-23' });
  assert.deepEqual(r.slots, []);
  assert.match(r.motivo, /cerrado/i);

  const ventana = buscar({ especialidad: 'clinica', desde: HOY });
  assert.ok(ventana.slots.every((s) => s.fecha !== '2026-11-23'));
});

test('disponibilidad: franja mañana y franja tarde', () => {
  const manana = buscar({ especialidad: 'clinica', desde: HOY, franja: 'manana' });
  const tarde = buscar({ especialidad: 'clinica', desde: HOY, franja: 'tarde' });
  assert.ok(manana.slots.length > 0 && tarde.slots.length > 0);
  for (const s of manana.slots) assert.ok(RS.horaAMinutos(s.hora) < 13 * 60, `${s.hora} no es de mañana`);
  for (const s of tarde.slots) assert.ok(RS.horaAMinutos(s.hora) >= 14 * 60, `${s.hora} no es de tarde`);
});

test('disponibilidad: nunca se sale de RS.DIAS_VISTA', () => {
  const r = buscar({ especialidad: 'traumatologia', desde: HOY });
  const ultimo = agenda.ultimoDiaIso(AHORA);
  for (const s of r.slots) {
    assert.ok(s.fecha >= HOY, `${s.fecha} es anterior a hoy`);
    assert.ok(s.fecha <= ultimo, `${s.fecha} supera la ventana`);
  }
});

test('disponibilidad: respeta los turnos ocupados de la agenda', () => {
  const slot = primerSlot('clinica');
  const partes = agenda.partesDeSlot(slot.slot_id);
  const ctx = {
    ahora: AHORA,
    gestion: {},
    turnos: [{ codigo: 'RS-ZZZZ', profId: partes.profId, fecha: partes.fecha, hora: partes.hora, origen: 'recepcion' }],
  };
  const r = buscar({ especialidad: 'clinica', desde: partes.fecha, hasta: partes.fecha }, ctx);
  assert.ok(!r.slots.some((s) => s.slot_id === slot.slot_id), 'el horario ocupado no debe ofrecerse');
});

test('disponibilidad: una cancelación de recepción libera el horario', () => {
  const esp = RS.ESPECIALIDADES.find((e) => e.id === 'clinica');
  const prof = esp.profesionales[0];
  let elegido = null;
  for (let i = 0; i < RS.DIAS_VISTA && !elegido; i += 1) {
    const fecha = RS.isoDe(RS.sumarDias(AHORA, i));
    if (!RS.atiende(prof, fecha)) continue;
    for (const hora of RS.generarHorarios(fecha, esp.dur)) {
      if (RS.esPasado(fecha, hora, AHORA)) continue;
      if (!RS.pseudoOcupado(prof.id, fecha, hora)) continue;
      elegido = { fecha, hora };
      break;
    }
  }
  assert.ok(elegido, 'debería existir al menos un horario pseudo-ocupado');

  const sinGestion = buscar({ especialidad: 'clinica', desde: elegido.fecha, hasta: elegido.fecha });
  assert.ok(!sinGestion.slots.some((s) => s.hora === elegido.hora && s.fecha === elegido.fecha));

  const gestion = { [RS.claveDe(prof.id, elegido.fecha, elegido.hora)]: { cancelado: true } };
  const conGestion = buscar(
    { especialidad: 'clinica', desde: elegido.fecha, hasta: elegido.fecha },
    { ahora: AHORA, turnos: [], gestion },
  );
  assert.ok(
    conGestion.slots.some((s) => s.hora === elegido.hora && s.fecha === elegido.fecha),
    'el horario cancelado tiene que volver a estar disponible',
  );
});

test('disponibilidad: sin lugar devuelve motivo y el próximo día con lugar', () => {
  const fecha = '2026-11-05'; // jueves: atiende el Dr. Sosa
  assert.equal(RS.fechaDeIso(fecha).getDay(), 4);
  const horas = RS.generarHorarios(fecha, 20);
  const r = buscar(
    { especialidad: 'cardiologia', desde: fecha, hasta: fecha },
    { ahora: AHORA, gestion: {}, turnos: ocupar(horas, 'sosa', fecha) },
  );
  assert.deepEqual(r.slots, []);
  assert.match(r.motivo, /No quedan horarios libres/i);
  assert.ok(r.proximo_dia > fecha, `se esperaba un próximo día posterior a ${fecha}, llegó ${r.proximo_dia}`);
});

test('disponibilidad: un profesional que no atiende ese día lo informa', () => {
  // El Dr. Sosa atiende martes y jueves; el 4 de noviembre es miércoles.
  const r = buscar({ especialidad: 'cardiologia', desde: '2026-11-04', hasta: '2026-11-04' });
  assert.deepEqual(r.slots, []);
  assert.match(r.motivo, /no atiende|cerrado/i);
});

test('proponer_reserva: rechaza slot mal formado, pasado, ocupado o fuera de grilla', () => {
  const malFormado = agenda.validarSlotParaReserva('sosa|2026-11-05', VACIO);
  assert.equal(malFormado.ok, false);
  assert.match(malFormado.motivo, /formato/i);

  const pasado = agenda.validarSlotParaReserva('sosa|2026-11-03|08:00', VACIO);
  assert.equal(pasado.ok, false);
  assert.match(pasado.motivo, /pasó/i);

  const fueraDeGrilla = agenda.validarSlotParaReserva('sosa|2026-11-05|08:10', VACIO);
  assert.equal(fueraDeGrilla.ok, false);
  assert.match(fueraDeGrilla.motivo, /grilla/i);

  const fueraDeVentana = agenda.validarSlotParaReserva('sosa|2027-05-05|08:00', VACIO);
  assert.equal(fueraDeVentana.ok, false);
  assert.match(fueraDeVentana.motivo, /fuera de la agenda/i);

  const slot = primerSlot('cardiologia');
  const partes = agenda.partesDeSlot(slot.slot_id);
  const ocupado = agenda.validarSlotParaReserva(slot.slot_id, {
    ahora: AHORA,
    gestion: {},
    turnos: [{ codigo: 'RS-AAAA', profId: partes.profId, fecha: partes.fecha, hora: partes.hora, origen: 'whatsapp' }],
  });
  assert.equal(ocupado.ok, false);
  assert.match(ocupado.motivo, /ocupado/i);

  const libre = agenda.validarSlotParaReserva(slot.slot_id, VACIO);
  assert.equal(libre.ok, true);
  assert.equal(libre.slot.profId, 'sosa');
  assert.equal(libre.slot.dur, 20);
  assert.match(libre.resumen, /Cardiología/);
});

test('proponer_reserva: la acción no incluye datos del paciente', () => {
  const slot = primerSlot('pediatria');
  const salida = herramientas.despachar('proponer_reserva', { slot_id: slot.slot_id }, VACIO);
  assert.equal(salida.ok, true);
  assert.equal(salida.accion.tipo, 'reservar');
  const claves = Object.keys(salida.accion.slot).sort();
  assert.deepEqual(claves, ['dur', 'espId', 'espNombre', 'fecha', 'hora', 'profId', 'profMp', 'profNombre'].sort());
});

test('cancelación: rechaza códigos ajenos, vencidos o inexistentes', () => {
  const ctx = {
    ahora: AHORA,
    gestion: {},
    turnos: [
      { codigo: 'RS-WWWW', profId: 'sosa', fecha: '2026-11-05', hora: '08:00', origen: 'whatsapp' },
      { codigo: 'RS-YYYY', profId: 'sosa', fecha: '2026-11-03', hora: '09:00', origen: 'web' },
      { codigo: 'RS-ZZZZ', profId: 'sosa', fecha: '2026-11-05', hora: '08:20', origen: 'web' },
    ],
  };

  const ajeno = agenda.buscarTurnoCancelable('RS-WWWW', ctx);
  assert.equal(ajeno.ok, false);
  assert.match(ajeno.motivo, /recepción/i);

  const vencido = agenda.buscarTurnoCancelable('RS-YYYY', ctx);
  assert.equal(vencido.ok, false);
  assert.match(vencido.motivo, /pasó/i);

  const inexistente = agenda.buscarTurnoCancelable('RS-QQQQ', ctx);
  assert.equal(inexistente.ok, false);

  const malFormado = agenda.buscarTurnoCancelable('1234', ctx);
  assert.equal(malFormado.ok, false);
  assert.match(malFormado.motivo, /formato/i);

  const propio = agenda.buscarTurnoCancelable('RS-ZZZZ', ctx);
  assert.equal(propio.ok, true);
  assert.match(propio.resumen, /RS-ZZZZ/);
});

test('reprogramación: exige la misma especialidad y un slot libre', () => {
  const ctx = {
    ahora: AHORA,
    gestion: {},
    turnos: [{ codigo: 'RS-CCCC', profId: 'sosa', fecha: '2026-11-05', hora: '08:00', origen: 'web' }],
  };
  const otraEsp = primerSlot('clinica', ctx);
  const mismaEsp = primerSlot('cardiologia', ctx);

  const cambio = herramientas.despachar(
    'proponer_reprogramacion',
    { codigo: 'RS-CCCC', slot_id: otraEsp.slot_id },
    ctx,
  );
  assert.equal(cambio.ok, false);
  assert.match(cambio.resultado.motivo, /especialidad/i);

  const ok = herramientas.despachar(
    'proponer_reprogramacion',
    { codigo: 'RS-CCCC', slot_id: mismaEsp.slot_id },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.accion.tipo, 'reprogramar');
  assert.equal(ok.accion.codigo, 'RS-CCCC');
  assert.match(ok.accion.resumen, /→/);
});

test('turnos del paciente: solo los web y futuros, con etiquetas derivadas del turnero', () => {
  const turnos = [
    { codigo: 'RS-AAAA', profId: 'sosa', fecha: '2026-11-05', hora: '08:00', origen: 'web' },
    { codigo: 'RS-BBBB', profId: 'sosa', fecha: '2026-11-05', hora: '08:20', origen: 'whatsapp' },
    { codigo: 'RS-CCCC', profId: 'sosa', fecha: '2026-11-03', hora: '08:00', origen: 'web' },
  ];
  const propios = agenda.turnosDelPaciente(turnos, AHORA);
  assert.deepEqual(propios.map((t) => t.codigo), ['RS-AAAA']);

  const linea = agenda.listaTurnosDelPaciente(turnos, AHORA);
  assert.match(linea, /RS-AAAA · Cardiología · Dr\. Ricardo Sosa · jueves 5 de noviembre 08:00/);
  assert.equal(agenda.listaTurnosDelPaciente([], AHORA), 'Ninguno');
});

test('datos del turno: sin paciente por diseño', () => {
  const slot = primerSlot('clinica');
  const validado = agenda.validarSlotParaReserva(slot.slot_id, VACIO);
  assert.equal(validado.ok, true);
  assert.equal(validado.slot.paciente, undefined);
  assert.equal(validado.slot.dni, undefined);
});
