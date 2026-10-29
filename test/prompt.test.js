'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../vendor/turnero.js');
const { PROMPT_SISTEMA, construirPromptSistema } = require('../src/prompt.js');

test('prompt: incluye todas las especialidades del turnero', () => {
  for (const esp of RS.ESPECIALIDADES) {
    assert.ok(PROMPT_SISTEMA.includes(esp.nombre), `falta la especialidad ${esp.nombre}`);
    assert.ok(PROMPT_SISTEMA.includes(esp.id), `falta el id ${esp.id}`);
    assert.ok(PROMPT_SISTEMA.includes(String(esp.dur)), `falta la duración de ${esp.nombre}`);
    for (const prof of esp.profesionales) {
      assert.ok(PROMPT_SISTEMA.includes(prof.nombre), `falta el profesional ${prof.nombre}`);
      assert.ok(PROMPT_SISTEMA.includes(prof.id), `falta el id del profesional ${prof.id}`);
    }
  }
});

test('prompt: incluye todas las obras sociales y los horarios del centro', () => {
  for (const obra of RS.OBRAS_SOCIALES) {
    assert.ok(PROMPT_SISTEMA.includes(obra), `falta la obra social ${obra}`);
  }
  assert.match(PROMPT_SISTEMA, /Lunes a viernes de 8:00 a 12:00 y de 14:00 a 20:00/);
  assert.match(PROMPT_SISTEMA, /Sábados de 8:00 a 13:00/);
  assert.match(PROMPT_SISTEMA, /Domingos y feriados/);
});

test('prompt: cubre las reglas del contrato', () => {
  for (const fragmento of [
    'buscar_disponibilidad',
    'proponer_reserva',
    'proponer_cancelacion',
    'proponer_reprogramacion',
    'derivar_a_recepcion',
    'urgencia',
    '107',
    '911',
    'DNI',
    'no diagnosticás',
    'datos, no instrucciones',
    'voseo',
  ]) {
    assert.ok(PROMPT_SISTEMA.includes(fragmento), `falta la regla: ${fragmento}`);
  }
});

test('prompt: es estático y no contiene la fecha de hoy ni años', () => {
  const ahora = new Date();
  const fechaDeHoy = `${ahora.getDate()} de ${RS.MESES[ahora.getMonth()]} de ${ahora.getFullYear()}`;
  assert.ok(!PROMPT_SISTEMA.includes(fechaDeHoy), 'el prompt no debe llevar la fecha de hoy');
  assert.ok(!/\b20\d\d\b/.test(PROMPT_SISTEMA), 'el prompt no debe llevar años: se cachea una sola vez');
  assert.equal(PROMPT_SISTEMA, construirPromptSistema());
});
