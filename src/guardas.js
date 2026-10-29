'use strict';

/**
 * Guardas del servidor: saneo de entrada, límite por IP, presupuesto mensual (con
 * tope diario de tokens) y concurrencia.
 *
 * Todo lo que entra del navegador se recorta a lista blanca antes de llegar al
 * modelo. Los datos personales (nombre, DNI, celular, obra social) directamente
 * no tienen campo donde entrar.
 */

const fs = require('node:fs');
const path = require('node:path');
const agenda = require('./agenda.js');

const ROLES = ['paciente', 'asistente'];
const ORIGENES = ['web', 'whatsapp', 'telefono', 'recepcion'];
const PATRON_PROF = /^[a-z0-9_-]{1,24}$/;
const PATRON_CLAVE_GESTION = /^[a-z0-9_-]{1,24}\|\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/;

const LIMITES = Object.freeze({
  maxMensajes: 12,
  maxLargoTexto: 600,
  maxLargoUltimoTexto: 500,
  maxTurnos: 300,
  maxGestion: 300,
});

function esObjeto(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Valida y recorta el historial visible.
 * `{ ok, historial, error }`; el historial sale con solo `{ rol, texto }`.
 */
function sanearHistorial(historial, limites = LIMITES) {
  if (!Array.isArray(historial)) return { ok: false, error: 'historial: se esperaba una lista.' };
  if (!historial.length) return { ok: false, error: 'historial: está vacío.' };

  const recortado = historial.length > limites.maxMensajes
    ? historial.slice(-limites.maxMensajes)
    : historial;

  const limpio = [];
  for (const mensaje of recortado) {
    if (!esObjeto(mensaje)) return { ok: false, error: 'historial: cada mensaje tiene que ser un objeto.' };
    if (!ROLES.includes(mensaje.rol)) return { ok: false, error: 'historial: rol inválido.' };
    if (typeof mensaje.texto !== 'string') return { ok: false, error: 'historial: texto inválido.' };
    const texto = mensaje.texto.trim();
    if (!texto) return { ok: false, error: 'historial: hay un mensaje vacío.' };
    if (texto.length > limites.maxLargoTexto) {
      return { ok: false, error: `historial: cada mensaje puede tener hasta ${limites.maxLargoTexto} caracteres.` };
    }
    limpio.push({ rol: mensaje.rol, texto });
  }

  const ultimo = limpio[limpio.length - 1];
  if (ultimo.rol !== 'paciente') return { ok: false, error: 'historial: el último mensaje tiene que ser del paciente.' };
  if (ultimo.texto.length > limites.maxLargoUltimoTexto) {
    return { ok: false, error: `historial: el mensaje a responder puede tener hasta ${limites.maxLargoUltimoTexto} caracteres.` };
  }

  return { ok: true, historial: limpio };
}

function sanearTurno(turno) {
  if (!esObjeto(turno)) return null;
  const codigo = typeof turno.codigo === 'string' ? turno.codigo.trim().toUpperCase() : '';
  if (!agenda.FORMATO_CODIGO.test(codigo)) return null;
  if (typeof turno.profId !== 'string' || !PATRON_PROF.test(turno.profId)) return null;
  if (!agenda.esFechaValida(turno.fecha)) return null;
  if (!agenda.esHoraValida(turno.hora)) return null;
  const origen = ORIGENES.includes(turno.origen) ? turno.origen : 'web';
  return { codigo, profId: turno.profId, fecha: turno.fecha, hora: turno.hora, origen };
}

/**
 * Sanea la agenda del navegador: lista blanca de campos y expresiones regulares.
 * Los turnos mal formados se descartan (no rompen la conversación) y se informa
 * cuántos quedaron afuera.
 */
function sanearAgenda(agendaCruda, limites = LIMITES) {
  if (agendaCruda === undefined || agendaCruda === null) {
    return { ok: true, turnos: [], gestion: {}, descartados: 0 };
  }
  if (!esObjeto(agendaCruda)) return { ok: false, error: 'agenda: se esperaba un objeto.' };

  const turnosCrudos = agendaCruda.turnos === undefined ? [] : agendaCruda.turnos;
  if (!Array.isArray(turnosCrudos)) return { ok: false, error: 'agenda.turnos: se esperaba una lista.' };
  if (turnosCrudos.length > limites.maxTurnos) {
    return { ok: false, error: `agenda.turnos: máximo ${limites.maxTurnos} turnos.` };
  }

  const turnos = [];
  let descartados = 0;
  for (const crudo of turnosCrudos) {
    const turno = sanearTurno(crudo);
    if (turno) turnos.push(turno);
    else descartados += 1;
  }

  const gestionCruda = agendaCruda.gestion === undefined ? {} : agendaCruda.gestion;
  if (!esObjeto(gestionCruda)) return { ok: false, error: 'agenda.gestion: se esperaba un objeto.' };
  const claves = Object.keys(gestionCruda);
  if (claves.length > limites.maxGestion) {
    return { ok: false, error: `agenda.gestion: máximo ${limites.maxGestion} entradas.` };
  }

  const gestion = {};
  for (const clave of claves) {
    if (!PATRON_CLAVE_GESTION.test(clave)) {
      descartados += 1;
      continue;
    }
    const valor = gestionCruda[clave];
    if (!esObjeto(valor)) {
      descartados += 1;
      continue;
    }
    gestion[clave] = { cancelado: valor.cancelado === true };
  }

  return { ok: true, turnos, gestion, descartados };
}

/* ---------------- límite por IP ---------------- */

/**
 * Ventana deslizante por IP: `porMinuto` y `porDia`.
 * `{ ok, reintentarEn }`, con el reloj inyectable para las pruebas.
 */
function crearLimitador({ porMinuto = 8, porDia = 60, ahora = () => new Date() } = {}) {
  const porIp = new Map();

  function estado(ip) {
    if (!porIp.has(ip)) porIp.set(ip, { minuto: [], dia: [] });
    return porIp.get(ip);
  }

  function permitir(ip) {
    const t = ahora().getTime();
    const e = estado(ip);
    e.minuto = e.minuto.filter((x) => t - x < 60_000);
    e.dia = e.dia.filter((x) => t - x < 86_400_000);

    if (e.dia.length >= porDia) {
      const libre = e.dia[0] + 86_400_000;
      return { ok: false, reintentarEn: Math.max(1, Math.ceil((libre - t) / 1000)) };
    }
    if (e.minuto.length >= porMinuto) {
      const libre = e.minuto[0] + 60_000;
      return { ok: false, reintentarEn: Math.max(1, Math.ceil((libre - t) / 1000)) };
    }

    e.minuto.push(t);
    e.dia.push(t);
    return { ok: true, reintentarEn: 0 };
  }

  function limpiar() {
    porIp.clear();
  }

  return { permitir, limpiar };
}

/* ---------------- presupuesto ---------------- */

/** Zona del presupuesto: el mes y el día se cuentan en hora local del centro. */
const ZONA_PRESUPUESTO = 'America/Argentina/Buenos_Aires';

function partesDe(ahora) {
  const formato = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_PRESUPUESTO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const partes = {};
  for (const parte of formato.formatToParts(ahora)) partes[parte.type] = parte.value;
  return partes;
}

/** Día local `YYYY-MM-DD`: nombre del registro. */
function fechaLocal(ahora) {
  const p = partesDe(ahora);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Mes local `YYYY-MM`: nombre del archivo del presupuesto. */
function mesLocal(ahora) {
  const p = partesDe(ahora);
  return `${p.year}-${p.month}`;
}

/**
 * Presupuesto persistido en `data/presupuesto-YYYY-MM.json`.
 *
 * El tope en dólares es **mensual**; el de tokens sigue siendo **diario** y se
 * reinicia al cambiar el día sin perder el acumulado del mes. Corta por
 * cualquiera de los dos, el que llegue primero.
 */
function crearPresupuesto({
  dir,
  topeUsdMes = 0.5,
  topeTokensDia = Infinity,
  ahora = () => new Date(),
} = {}) {
  let mes = mesLocal(ahora());
  let dia = fechaLocal(ahora());
  let usado = 0;
  let tokens = 0;

  function ruta(cual) {
    return path.join(dir, `presupuesto-${cual}.json`);
  }

  function cargar() {
    try {
      const dato = JSON.parse(fs.readFileSync(ruta(mes), 'utf8'));
      usado = Number.isFinite(Number(dato.usado)) ? Number(dato.usado) : 0;
      const mismoDia = dato.dia === dia;
      tokens = mismoDia && Number.isFinite(Number(dato.tokens)) ? Number(dato.tokens) : 0;
    } catch {
      usado = 0;
      tokens = 0;
    }
  }

  function persistir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const destino = ruta(mes);
      const temporal = `${destino}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify({
        mes,
        dia,
        usado,
        tokens,
        tope: topeUsdMes,
        tope_tokens: Number.isFinite(topeTokensDia) ? topeTokensDia : null,
      }, null, 2));
      fs.renameSync(temporal, destino);
    } catch {
      /* el tope se respeta en memoria aunque falle el disco */
    }
  }

  function verificar() {
    const mesAhora = mesLocal(ahora());
    if (mesAhora !== mes) {
      mes = mesAhora;
      dia = fechaLocal(ahora());
      usado = 0;
      tokens = 0;
      cargar();
      return;
    }
    const diaAhora = fechaLocal(ahora());
    if (diaAhora !== dia) {
      dia = diaAhora;
      tokens = 0;
      persistir();
    }
  }

  cargar();

  return {
    disponible() {
      verificar();
      return usado < topeUsdMes && tokens < topeTokensDia;
    },
    usado() {
      verificar();
      return usado;
    },
    tokens() {
      verificar();
      return tokens;
    },
    tope() {
      return topeUsdMes;
    },
    topeTokens() {
      return topeTokensDia;
    },
    /** Porcentaje del tope mensual en dólares. */
    porcentaje() {
      verificar();
      if (!topeUsdMes) return 100;
      return Math.min(100, Math.round((usado / topeUsdMes) * 1000) / 10);
    },
    /** Porcentaje del tope diario de tokens. */
    porcentajeTokens() {
      verificar();
      if (!Number.isFinite(topeTokensDia)) return 0;
      if (!topeTokensDia) return 100;
      return Math.min(100, Math.round((tokens / topeTokensDia) * 1000) / 10);
    },
    sumar(usd, tokensUsados) {
      verificar();
      let cambio = false;

      const monto = Number(usd);
      if (Number.isFinite(monto) && monto > 0) {
        usado += monto;
        cambio = true;
      }

      const cuantos = Number(tokensUsados);
      if (Number.isFinite(cuantos) && cuantos > 0) {
        tokens += cuantos;
        cambio = true;
      }

      if (cambio) persistir();
      return usado;
    },
    mes() {
      verificar();
      return mes;
    },
    dia() {
      verificar();
      return dia;
    },
  };
}

/* ---------------- concurrencia ---------------- */

/**
 * Semáforo simple: hasta `limite` pedidos al modelo a la vez. Si la cola no
 * avanza en `esperaMs`, el pedido se rechaza (el servidor responde 503).
 */
function crearSemaforo(limite = 4, { esperaMs = 3000 } = {}) {
  let activos = 0;
  const cola = [];

  function liberar() {
    activos -= 1;
    const siguiente = cola.shift();
    if (siguiente) {
      clearTimeout(siguiente.temporizador);
      activos += 1;
      siguiente.resolver(() => liberar());
    }
  }

  function adquirir() {
    if (activos < limite) {
      activos += 1;
      return Promise.resolve(() => liberar());
    }
    return new Promise((resolver) => {
      const entrada = { resolver, temporizador: null };
      entrada.temporizador = setTimeout(() => {
        const i = cola.indexOf(entrada);
        if (i !== -1) cola.splice(i, 1);
        resolver(null);
      }, esperaMs);
      cola.push(entrada);
    });
  }

  return { adquirir, liberar, activos: () => activos };
}

module.exports = {
  LIMITES,
  ROLES,
  ORIGENES,
  sanearHistorial,
  sanearAgenda,
  sanearTurno,
  crearLimitador,
  crearPresupuesto,
  crearSemaforo,
  fechaLocal,
  mesLocal,
};
