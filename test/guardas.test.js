'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guardas = require('../src/guardas.js');

function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recepcionista-'));
}

test('límite por IP: minuto y día con reloj inyectable', () => {
  let t = new Date(2026, 10, 3, 10, 0, 0).getTime();
  const limitador = guardas.crearLimitador({
    porMinuto: 2,
    porDia: 5,
    ahora: () => new Date(t),
  });

  assert.equal(limitador.permitir('1.2.3.4').ok, true);
  assert.equal(limitador.permitir('1.2.3.4').ok, true);

  const tercero = limitador.permitir('1.2.3.4');
  assert.equal(tercero.ok, false);
  assert.ok(tercero.reintentarEn >= 1 && tercero.reintentarEn <= 60);

  // Otra IP no se ve afectada.
  assert.equal(limitador.permitir('5.6.7.8').ok, true);

  // Pasado el minuto, vuelve a haber lugar.
  t += 61_000;
  assert.equal(limitador.permitir('1.2.3.4').ok, true);
  assert.equal(limitador.permitir('1.2.3.4').ok, true);

  // Tope diario: 5 por día.
  t += 61_000;
  const cuarto = limitador.permitir('1.2.3.4');
  assert.equal(cuarto.ok, true);
  const quinto = limitador.permitir('1.2.3.4');
  assert.equal(quinto.ok, false);
  assert.ok(quinto.reintentarEn > 60);
});

test('límite por IP: la ventana de 24 horas se limpia sola', () => {
  let t = new Date(2026, 10, 3, 23, 59, 0).getTime();
  const limitador = guardas.crearLimitador({ porMinuto: 10, porDia: 1, ahora: () => new Date(t) });
  assert.equal(limitador.permitir('9.9.9.9').ok, true);
  assert.equal(limitador.permitir('9.9.9.9').ok, false);
  t += 86_400_000 + 1000; // ventana deslizante de 24 h
  assert.equal(limitador.permitir('9.9.9.9').ok, true);
});

test('presupuesto mensual: acumula en el mes y corta al llegar al tope', () => {
  const dir = dirTemporal();
  const reloj = () => new Date(2026, 10, 3, 12, 0, 0);

  const p = guardas.crearPresupuesto({ dir, topeUsdMes: 1.5, ahora: reloj });
  assert.equal(p.disponible(), true);
  assert.equal(p.porcentaje(), 0);
  assert.equal(p.mes(), '2026-11');

  p.sumar(0.75);
  assert.equal(p.usado(), 0.75);
  assert.equal(p.porcentaje(), 50);
  assert.equal(p.disponible(), true);

  const archivo = path.join(dir, 'presupuesto-2026-11.json');
  assert.ok(fs.existsSync(archivo), 'tiene que persistir el gasto del mes');

  // Reinicio: se lee el archivo al arrancar.
  const otra = guardas.crearPresupuesto({ dir, topeUsdMes: 1.5, ahora: reloj });
  assert.equal(otra.usado(), 0.75);

  otra.sumar(0.75);
  assert.equal(otra.disponible(), false, 'llegó al tope del mes');
  assert.equal(otra.porcentaje(), 100);

  // Otro día del mismo mes: el gasto en dólares no se reinicia.
  assert.equal(otra.usado(), 0.75 + 0.75);
  assert.equal(otra.disponible(), false);
});

test('presupuesto mensual: al cambiar el mes arranca de cero en un archivo nuevo', () => {
  const dir = dirTemporal();
  let t = new Date(2026, 10, 28, 12, 0, 0);
  const p = guardas.crearPresupuesto({ dir, topeUsdMes: 1, ahora: () => t });

  p.sumar(0.9, 500);
  assert.equal(p.usado(), 0.9);
  assert.equal(fs.existsSync(path.join(dir, 'presupuesto-2026-11.json')), true);

  t = new Date(2026, 11, 1, 0, 30, 0);
  assert.equal(p.mes(), '2026-12');
  assert.equal(p.usado(), 0, 'el mes nuevo arranca en cero');
  assert.equal(p.tokens(), 0);
  assert.equal(p.disponible(), true);

  p.sumar(0.4);
  assert.equal(fs.existsSync(path.join(dir, 'presupuesto-2026-12.json')), true);
  const viejo = JSON.parse(fs.readFileSync(path.join(dir, 'presupuesto-2026-11.json'), 'utf8'));
  assert.equal(viejo.usado, 0.9, 'el archivo del mes anterior no se toca');
});

test('presupuesto: corta por tokens del día aunque quede saldo del mes', () => {
  const dir = dirTemporal();
  let t = new Date(2026, 10, 3, 12, 0, 0);
  const p = guardas.crearPresupuesto({ dir, topeUsdMes: 100, topeTokensDia: 1000, ahora: () => t });

  p.sumar(0.5, 400);
  assert.equal(p.porcentajeTokens(), 40);
  assert.equal(p.disponible(), true);

  p.sumar(0, 600);
  assert.equal(p.disponible(), false, '1000 tokens agotan el tope del día');
  assert.equal(p.porcentajeTokens(), 100);
  assert.ok(p.porcentaje() < 100, 'el tope mensual no se tocó');

  // Al día siguiente el tope de tokens vuelve, pero el gasto del mes sigue.
  t = new Date(2026, 10, 4, 8, 0, 0);
  assert.equal(p.tokens(), 0);
  assert.equal(p.usado(), 0.5);
  assert.equal(p.disponible(), true);
});

test('presupuesto: montos inválidos no rompen ni suman', () => {
  const dir = dirTemporal();
  const p = guardas.crearPresupuesto({ dir, topeUsdMes: 1, ahora: () => new Date(2026, 10, 3) });
  p.sumar(NaN);
  p.sumar(-1);
  p.sumar('x');
  assert.equal(p.usado(), 0);
  assert.equal(p.tokens(), 0);
});

test('saneo de historial: tipos, longitudes y último mensaje', () => {
  const valido = [
    { rol: 'paciente', texto: 'Hola' },
    { rol: 'asistente', texto: '¿Qué necesitás?' },
    { rol: 'paciente', texto: 'Un turno' },
  ];
  const r = guardas.sanearHistorial(valido);
  assert.equal(r.ok, true);
  assert.deepEqual(r.historial[0], { rol: 'paciente', texto: 'Hola' });

  assert.equal(guardas.sanearHistorial('hola').ok, false);
  assert.equal(guardas.sanearHistorial([]).ok, false);
  assert.equal(guardas.sanearHistorial([{ rol: 'sistema', texto: 'x' }, { rol: 'paciente', texto: 'y' }]).ok, false);
  assert.equal(guardas.sanearHistorial([{ rol: 'paciente', texto: '   ' }]).ok, false);
  assert.equal(guardas.sanearHistorial([{ rol: 'paciente', texto: 42 }]).ok, false);
  assert.equal(guardas.sanearHistorial([{ rol: 'paciente', texto: 'a'.repeat(601) }]).ok, false);
  assert.equal(guardas.sanearHistorial([
    { rol: 'paciente', texto: 'a' },
    { rol: 'asistente', texto: 'b' },
  ]).ok, false);
  assert.equal(guardas.sanearHistorial([{ rol: 'paciente', texto: 'a'.repeat(501) }]).ok, false);

  // Más de 12: se queda con los últimos 12.
  const largo = Array.from({ length: 20 }, (_, i) => ({ rol: 'paciente', texto: `m${i}` }));
  const recortado = guardas.sanearHistorial(largo);
  assert.equal(recortado.ok, true);
  assert.equal(recortado.historial.length, 12);
  assert.equal(recortado.historial.at(-1).texto, 'm19');

  // Solo se conserva rol y texto.
  const conExtra = guardas.sanearHistorial([{ rol: 'paciente', texto: 'Hola', dni: '30111222' }]);
  assert.equal(conExtra.ok, true);
  assert.deepEqual(Object.keys(conExtra.historial[0]).sort(), ['rol', 'texto']);
});

test('saneo de agenda: lista blanca, descarte de datos personales y límites', () => {
  const r = guardas.sanearAgenda({
    turnos: [
      {
        codigo: 'RS-AB12',
        profId: 'sosa',
        fecha: '2026-11-05',
        hora: '15:20',
        origen: 'web',
        paciente: 'Juan Pérez',
        dni: '30111222',
        celular: '2984123456',
        obra: 'OSDE',
        notas: 'privado',
      },
      { codigo: 'mal', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web' },
      { codigo: 'RS-CD34', profId: 'sosa', fecha: '2026-11-31', hora: '15:20', origen: 'web' },
      { codigo: 'RS-EF56', profId: 'sosa', fecha: '2026-11-05', hora: '25:00', origen: 'web' },
      'no soy un turno',
    ],
    gestion: {
      'sosa|2026-11-05|15:20': { cancelado: true, notas: 'privado' },
      'clave-invalida': { cancelado: true },
      'sosa|2026-11-05|15:40': { cancelado: 'si' },
    },
  });

  assert.equal(r.ok, true);
  assert.equal(r.turnos.length, 1);
  assert.deepEqual(r.turnos[0], {
    codigo: 'RS-AB12', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web',
  });
  assert.equal(r.descartados, 5);
  assert.deepEqual(r.gestion, {
    'sosa|2026-11-05|15:20': { cancelado: true },
    'sosa|2026-11-05|15:40': { cancelado: false },
  });

  assert.equal(guardas.sanearAgenda(undefined).ok, true);
  assert.equal(guardas.sanearAgenda({ turnos: {} }).ok, false);
  assert.equal(guardas.sanearAgenda({ gestion: [] }).ok, false);
  assert.equal(guardas.sanearAgenda({ turnos: new Array(301).fill({}) }).ok, false);
  assert.equal(guardas.sanearAgenda({ gestion: Object.fromEntries(
    Array.from({ length: 301 }, (_, i) => [
      `sosa|2026-11-05|${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      {},
    ]),
  ) }).ok, false);
  assert.equal(guardas.sanearAgenda('agenda').ok, false);
});

test('semáforo: limita la concurrencia y encola hasta que se libera', async () => {
  const semaforo = guardas.crearSemaforo(1, { esperaMs: 500 });
  const uno = await semaforo.adquirir();
  assert.equal(typeof uno, 'function');
  assert.equal(semaforo.activos(), 1);

  const esperando = semaforo.adquirir();
  uno();
  const dos = await esperando;
  assert.equal(typeof dos, 'function');
  dos();
  assert.equal(semaforo.activos(), 0);

  const rapido = guardas.crearSemaforo(1, { esperaMs: 50 });
  const ocupado = await rapido.adquirir();
  assert.equal(await rapido.adquirir(), null, 'sin lugar y sin liberación, rechaza');
  ocupado();
});
