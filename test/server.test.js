'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { servidorDePrueba } = require('./ayudas.js');

const HISTORIAL = [{ rol: 'paciente', texto: 'Necesito un turno con cardiología' }];
const ORIGEN = 'http://127.0.0.1:8773';

function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recepcionista-srv-'));
}

async function pedirChat(base, cuerpo, extra = {}) {
  const respuesta = await fetch(`${base}/api/recepcionista/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
  const texto = await respuesta.text();
  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch {
    datos = texto;
  }
  return { estado: respuesta.status, datos, cabeceras: respuesta.headers };
}

test('chat: 200 con respuesta, acciones, traza, modo y ms', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const r = await pedirChat(base, { historial: HISTORIAL, agenda: { turnos: [], gestion: {} } });
    assert.equal(r.estado, 200);
    assert.equal(typeof r.datos.respuesta, 'string');
    assert.ok(r.datos.respuesta.length > 0);
    assert.equal(r.datos.modo, 'ia');
    assert.ok(Array.isArray(r.datos.acciones));
    assert.equal(r.datos.acciones[0].tipo, 'reservar');
    assert.ok(Array.isArray(r.datos.traza));
    assert.deepEqual(r.datos.traza.map((t) => t.herramienta), ['buscar_disponibilidad', 'proponer_reserva']);
    assert.equal(typeof r.datos.ms, 'number');
    // Los datos del paciente no viajan: la acción solo trae el turno.
    assert.ok(!('paciente' in r.datos.acciones[0].slot));

    // Presupuesto y registro persistidos.
    const archivos = fs.readdirSync(datos);
    assert.ok(archivos.some((a) => /^presupuesto-\d{4}-\d{2}\.json$/.test(a)), 'presupuesto mensual');
    assert.ok(archivos.some((a) => a.startsWith('registro-')));
  } finally {
    await cerrar();
  }
});

test('chat: registro sin texto de mensajes ni datos personales', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const r = await pedirChat(base, {
      historial: HISTORIAL,
      agenda: {
        turnos: [{
          codigo: 'RS-AB12', profId: 'sosa', fecha: '2026-11-05', hora: '15:20', origen: 'web',
          paciente: 'Juan Pérez', dni: '30111222', celular: '2984123456',
        }],
        gestion: {},
      },
    });
    assert.equal(r.estado, 200);

    const archivo = fs.readdirSync(datos).find((a) => a.startsWith('registro-'));
    const lineas = fs.readFileSync(path.join(datos, archivo), 'utf8').trim().split('\n');
    assert.equal(lineas.length, 1);
    const registro = JSON.parse(lineas[0]);

    for (const clave of ['ts', 'ip_hash', 'modelo', 'modo', 'ms', 'llamadas', 'herramientas', 'tokens', 'usd', 'stop_reason', 'error']) {
      assert.ok(clave in registro, `falta ${clave} en el registro`);
    }
    assert.equal(registro.ip_hash.length, 12);
    assert.equal(registro.modo, 'ia');
    assert.ok(registro.usd > 0);
    assert.deepEqual(registro.tokens, { entrada: 5400, salida: 360, cache_w: 0, cache_r: 3600 });

    const crudo = lineas[0];
    for (const dato of ['cardiología', 'Juan Pérez', '30111222', '2984123456', '127.0.0.1']) {
      assert.ok(!crudo.includes(dato), `el registro no debe contener "${dato}"`);
    }
  } finally {
    await cerrar();
  }
});

test('chat: 400 por cuerpo inválido', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const casos = [
      { historial: [], agenda: {} },
      { historial: [{ rol: 'paciente', texto: 'x' }], agenda: { turnos: new Array(301).fill({}) } },
      { historial: [{ rol: 'paciente', texto: 'a'.repeat(501) }], agenda: {} },
      { historial: 'no', agenda: {} },
    ];
    for (const cuerpo of casos) {
      const r = await pedirChat(base, cuerpo);
      assert.equal(r.estado, 400, JSON.stringify(cuerpo).slice(0, 80));
      assert.equal(typeof r.datos.error, 'string');
    }

    const roto = await pedirChat(base, '{no es json');
    assert.equal(roto.estado, 400);
    assert.equal(typeof roto.datos.error, 'string');

    const lista = await pedirChat(base, '[]');
    assert.equal(lista.estado, 400);
  } finally {
    await cerrar();
  }
});

test('chat: 413 cuando el cuerpo pasa de 32 KB', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const grande = await pedirChat(base, {
      historial: [{ rol: 'paciente', texto: 'a'.repeat(40 * 1024) }],
      agenda: {},
    });
    assert.equal(grande.estado, 413);
    assert.match(grande.datos.error, /grande/i);
  } finally {
    await cerrar();
  }
});

test('chat: 429 por límite de IP con reintentar_en_s', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos, porMinuto: 1 });
  try {
    const primera = await pedirChat(base, { historial: HISTORIAL, agenda: {} });
    assert.equal(primera.estado, 200);

    const segunda = await pedirChat(base, { historial: HISTORIAL, agenda: {} });
    assert.equal(segunda.estado, 429);
    assert.match(segunda.datos.error, /Demasiados pedidos/);
    assert.ok(segunda.datos.reintentar_en_s >= 1);

    // Otra IP (X-Real-IP desde loopback) no está limitada.
    const otra = await pedirChat(base, { historial: HISTORIAL, agenda: {} }, { headers: { 'x-real-ip': '203.0.113.7' } });
    assert.equal(otra.estado, 200);
  } finally {
    await cerrar();
  }
});

test('CORS: solo los orígenes configurados, y OPTIONS responde 204', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const permitido = await fetch(`${base}/api/recepcionista/chat`, {
      method: 'OPTIONS',
      headers: { origin: ORIGEN },
    });
    assert.equal(permitido.status, 204);
    assert.equal(permitido.headers.get('access-control-allow-origin'), ORIGEN);
    assert.match(permitido.headers.get('access-control-allow-methods'), /POST/);

    const ajeno = await fetch(`${base}/api/recepcionista/chat`, {
      method: 'OPTIONS',
      headers: { origin: 'https://sitio-ajeno.example' },
    });
    assert.equal(ajeno.status, 204);
    assert.equal(ajeno.headers.get('access-control-allow-origin'), null);

    const conOrigen = await fetch(`${base}/api/recepcionista/salud`, { headers: { origin: ORIGEN } });
    assert.equal(conOrigen.headers.get('access-control-allow-origin'), ORIGEN);

    const sinOrigen = await fetch(`${base}/api/recepcionista/salud`);
    assert.equal(sinOrigen.headers.get('access-control-allow-origin'), null);
  } finally {
    await cerrar();
  }
});

test('salud: estado del servicio y presupuesto', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const r = await fetch(`${base}/api/recepcionista/salud`);
    assert.equal(r.status, 200);
    const datosSalud = await r.json();
    assert.deepEqual(Object.keys(datosSalud).sort(), [
      'ia_disponible', 'modelo', 'ok', 'presupuesto_mes_pct', 'tokens_dia_pct',
    ]);
    assert.equal(datosSalud.ok, true);
    assert.equal(datosSalud.modelo, 'simulado');
    assert.equal(datosSalud.ia_disponible, true);
    assert.equal(datosSalud.presupuesto_mes_pct, 0);
    assert.equal(datosSalud.tokens_dia_pct, 0);

    await pedirChat(base, { historial: HISTORIAL, agenda: {} });
    const despues = await (await fetch(`${base}/api/recepcionista/salud`)).json();
    assert.ok(despues.presupuesto_mes_pct > 0);
    assert.ok(despues.tokens_dia_pct > 0);
  } finally {
    await cerrar();
  }
});

test('tope mensual agotado: 200 en modo respaldo con acciones del respaldo', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos, tope: '0' });
  try {
    const r = await pedirChat(base, { historial: HISTORIAL, agenda: {} });
    assert.equal(r.estado, 200);
    assert.equal(r.datos.modo, 'respaldo');
    assert.match(r.datos.respuesta, /no está disponible/i);
    assert.deepEqual(r.datos.traza, []);
    assert.equal(r.datos.acciones[0].tipo, 'turnero');
  } finally {
    await cerrar();
  }
});

test('sin clave de API: arranca y responde en modo respaldo', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({
    datos,
    entorno: { RECEPCIONISTA_MODELO: 'deepseek-v4.1-flash' },
  });
  try {
    const salud = await (await fetch(`${base}/api/recepcionista/salud`)).json();
    assert.equal(salud.ia_disponible, false);

    const r = await pedirChat(base, { historial: HISTORIAL, agenda: {} });
    assert.equal(r.estado, 200);
    assert.equal(r.datos.modo, 'respaldo');
    const opciones = r.datos.acciones.find((a) => a.tipo === 'opciones');
    assert.ok(opciones, 'el respaldo ofrece horarios reales si se nombró una especialidad');
  } finally {
    await cerrar();
  }
});

test('rutas: 404 desconocida y 405 con método incorrecto', async () => {
  const datos = dirTemporal();
  const { base, cerrar } = await servidorDePrueba({ datos });
  try {
    const desconocida = await fetch(`${base}/api/recepcionista/otra`);
    assert.equal(desconocida.status, 404);

    const getChat = await fetch(`${base}/api/recepcionista/chat`);
    assert.equal(getChat.status, 405);

    const raiz = await fetch(`${base}/`);
    assert.equal(raiz.status, 404, 'sin RECEPCIONISTA_ESTATICOS no se sirve nada');
  } finally {
    await cerrar();
  }
});

test('estáticos: sirve la carpeta indicada, sin listar ni salir de ella', async () => {
  const datos = dirTemporal();
  const sitio = dirTemporal();
  fs.writeFileSync(path.join(sitio, 'index.html'), '<!doctype html><title>ok</title>');
  fs.writeFileSync(path.join(sitio, 'app.js'), 'console.log(1)');
  fs.mkdirSync(path.join(sitio, 'sub'));
  fs.writeFileSync(path.join(sitio, 'sub', 'x.txt'), 'hola');

  const { base, cerrar } = await servidorDePrueba({
    datos,
    entorno: { RECEPCIONISTA_ESTATICOS: sitio },
  });
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(await js.text(), 'console.log(1)');

    const anidado = await fetch(`${base}/sub/x.txt`);
    assert.equal(anidado.status, 200);

    const directorio = await fetch(`${base}/sub/`);
    assert.equal(directorio.status, 404, 'no se listan directorios');

    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await cerrar();
  }
});
