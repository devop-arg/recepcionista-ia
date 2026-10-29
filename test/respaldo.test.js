'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../vendor/turnero.js');
const respaldo = require('../src/respaldo.js');

const AHORA = new Date(2026, 10, 3, 10, 42);

function conHistorial(texto) {
  return [{ rol: 'paciente', texto }];
}

test('idioma: detecta inglés y español', () => {
  assert.equal(respaldo.pareceIngles('I need a dermatologist next week'), true);
  assert.equal(respaldo.pareceIngles('Necesito un turno con cardiología'), false);
  assert.equal(respaldo.pareceIngles('Hola, ¿atienden con PAMI?'), false);
  assert.equal(respaldo.idiomaDe(conHistorial('I need an appointment please')), 'en');
  assert.equal(respaldo.idiomaDe(conHistorial('Quiero un turno')), 'es');
});

test('respaldo: texto según idioma, acción turnero siempre', () => {
  const es = respaldo.respuestaDeRespaldo({ historial: conHistorial('Hola'), ahora: AHORA });
  assert.match(es.respuesta, /no está disponible en este momento/);
  assert.match(es.respuesta, /turnero/);
  assert.deepEqual(es.acciones, [{ tipo: 'turnero' }]);

  const en = respaldo.respuestaDeRespaldo({
    historial: conHistorial('I need a cardiologist appointment'),
    ahora: AHORA,
  });
  assert.match(en.respuesta, /not available right now/);
});

test('respaldo: si nombra una especialidad ofrece hasta 3 turnos reales', () => {
  const r = respaldo.respuestaDeRespaldo({
    historial: conHistorial('Necesito un turno con cardiología'),
    turnos: [],
    gestion: {},
    ahora: AHORA,
  });

  assert.equal(r.acciones[0].tipo, 'turnero');
  const opciones = r.acciones.find((a) => a.tipo === 'opciones');
  assert.ok(opciones, 'debería haber opciones');
  assert.ok(opciones.slots.length >= 1 && opciones.slots.length <= 3);
  for (const slot of opciones.slots) {
    assert.equal(slot.especialidad, 'Cardiología');
    assert.ok(slot.slot_id.includes('|'));
    const partes = slot.slot_id.split('|');
    assert.ok(RS.profesionalPorId(partes[0]), 'el profesional tiene que existir');
  }
});

test('respaldo: sin especialidad no inventa opciones', () => {
  const r = respaldo.respuestaDeRespaldo({ historial: conHistorial('Hola, ¿cómo va?'), ahora: AHORA });
  assert.deepEqual(r.acciones, [{ tipo: 'turnero' }]);
});

test('respaldo: reconoce sinónimos simples', () => {
  const casos = [
    ['necesito un pediatra', 'pediatria'],
    ['me duele la piel, quiero un dermato', 'dermatologia'],
    ['turno con el oculista', 'oftalmologia'],
    ['quiero ver al traumatólogo', 'traumatologia'],
    ['necesito un ginecólogo', 'ginecologia'],
    ['algo de clínica general', 'clinica'],
    ['necesito un cardiólogo', 'cardiologia'],
  ];
  for (const [texto, espId] of casos) {
    const mencionadas = respaldo.especialidadesMencionadas(texto);
    assert.ok(mencionadas.some((e) => e.id === espId), `"${texto}" debería detectar ${espId}`);
  }
});

test('respaldo: es determinista', () => {
  const opciones = { historial: conHistorial('Turno con cardiología'), ahora: AHORA, turnos: [], gestion: {} };
  assert.deepEqual(respaldo.respuestaDeRespaldo(opciones), respaldo.respuestaDeRespaldo(opciones));
});
