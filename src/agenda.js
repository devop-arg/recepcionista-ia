'use strict';

/**
 * Agenda: implementación pura de las herramientas sobre `vendor/turnero.js`.
 *
 * Nada de red, nada de estado propio. Cada función recibe la agenda saneada
 * (`turnos`, `gestion`), el reloj (`ahora`) y devuelve datos planos.
 */

const RS = require('../vendor/turnero.js');

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FORMATO_HORA = /^\d{2}:\d{2}$/;
const FORMATO_SLOT = /^([a-z0-9_-]{1,24})\|(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})$/;
const FORMATO_CODIGO = /^RS-[A-Z0-9]{4}$/;

const MAX_SLOTS = 6;
const POR_DIA_MAX = 4;
const LIMITE_MANANA = 13 * 60;
const LIMITE_TARDE = 14 * 60;

function esFechaValida(iso) {
  if (typeof iso !== 'string' || !FORMATO_FECHA.test(iso)) return false;
  const [a, m, d] = iso.split('-').map(Number);
  const fecha = new Date(a, m - 1, d);
  return fecha.getFullYear() === a && fecha.getMonth() === m - 1 && fecha.getDate() === d;
}

function esHoraValida(hora) {
  if (typeof hora !== 'string' || !FORMATO_HORA.test(hora)) return false;
  const [h, m] = hora.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function hoyIso(ahora) {
  return RS.isoDe(ahora || new Date());
}

/** Último día consultable: hoy + DIAS_VISTA - 1. */
function ultimoDiaIso(ahora) {
  return RS.isoDe(RS.sumarDias(ahora || new Date(), RS.DIAS_VISTA - 1));
}

function especialidadPorId(id) {
  return RS.ESPECIALIDADES.find((e) => e.id === id) || null;
}

function enFranja(hora, franja) {
  const m = RS.horaAMinutos(hora);
  if (franja === 'manana') return m < LIMITE_MANANA;
  if (franja === 'tarde') return m >= LIMITE_TARDE;
  return true;
}

function contextoNormalizado(ctx = {}) {
  return {
    turnos: Array.isArray(ctx.turnos) ? ctx.turnos : [],
    gestion: ctx.gestion && typeof ctx.gestion === 'object' ? ctx.gestion : {},
    ahora: ctx.ahora instanceof Date ? ctx.ahora : new Date(),
  };
}

/** `<profId>|<YYYY-MM-DD>|<HH:MM>` → partes, o null si no valida. */
function partesDeSlot(slotId) {
  const m = FORMATO_SLOT.exec(String(slotId == null ? '' : slotId));
  if (!m) return null;
  const [, profId, fecha, hora] = m;
  if (!esFechaValida(fecha) || !esHoraValida(hora)) return null;
  return { profId, fecha, hora };
}

function slotId(profId, fecha, hora) {
  return RS.claveDe(profId, fecha, hora);
}

function dentroDeVentana(fecha, ahora) {
  return fecha >= hoyIso(ahora) && fecha <= ultimoDiaIso(ahora);
}

/** Hora que pertenece a la grilla real de ese profesional y especialidad. */
function horaEnGrilla(prof, esp, fecha, hora) {
  return RS.generarHorarios(fecha, esp.dur).includes(hora);
}

/**
 * Slot listo para el modelo: sin datos del paciente, solo lo que hace falta
 * para volver a reservar.
 */
function describirSlot(esp, prof, fecha, hora) {
  return {
    slot_id: slotId(prof.id, fecha, hora),
    especialidad: esp.nombre,
    profesional: prof.nombre,
    fecha,
    dia: RS.formatearFechaLarga(fecha),
    hora,
  };
}

/** Datos del turno para la tarjeta del navegador (sin paciente). */
function datosDelTurno(esp, prof, fecha, hora) {
  return {
    espId: esp.id,
    espNombre: esp.nombre,
    profId: prof.id,
    profNombre: prof.nombre,
    profMp: prof.mp,
    fecha,
    hora,
    dur: esp.dur,
  };
}

function resumenSlot(esp, prof, fecha, hora) {
  return `${esp.nombre} · ${prof.nombre} · ${RS.formatearFechaLarga(fecha)} ${hora}`;
}

function horaDisponible(prof, fecha, hora, ctx) {
  return RS.disponible(prof, fecha, hora, ctx.turnos, ctx.ahora, ctx.gestion);
}

/** Turnos del dispositivo que son del paciente: origen web y todavía futuros. */
function turnosDelPaciente(turnos, ahora) {
  const base = ahora || new Date();
  return (turnos || []).filter((t) => t
    && (t.origen || 'web') === 'web'
    && typeof t.fecha === 'string'
    && typeof t.hora === 'string'
    && !RS.esPasado(t.fecha, t.hora, base));
}

function turnoPorCodigo(turnos, codigo) {
  const buscado = String(codigo || '').toUpperCase();
  return (turnos || []).find((t) => t && String(t.codigo).toUpperCase() === buscado) || null;
}

function etiquetasDeTurno(turno) {
  const info = RS.profesionalPorId(turno.profId);
  return {
    espNombre: info ? info.esp.nombre : 'Consulta',
    profNombre: info ? info.prof.nombre : 'Profesional a confirmar',
  };
}

/** Línea del bloque `<contexto>` para un turno del paciente. */
function describirTurnoDelPaciente(turno) {
  const { espNombre, profNombre } = etiquetasDeTurno(turno);
  return `${turno.codigo} · ${espNombre} · ${profNombre} · ${RS.formatearFechaLarga(turno.fecha)} ${turno.hora}`;
}

function listaTurnosDelPaciente(turnos, ahora) {
  const lista = turnosDelPaciente(turnos, ahora);
  return lista.length ? lista.map(describirTurnoDelPaciente).join('; ') : 'Ninguno';
}

/** Profesionales candidatos según la entrada. */
function profesionalesDe(esp, profesional) {
  if (!profesional) return esp.profesionales;
  return esp.profesionales.filter((p) => p.id === profesional);
}

/**
 * Días con horarios libres para una especialidad/profesional/franja.
 * Devuelve `[{ fecha, slots }]` en orden cronológico, con `POR_DIA_MAX` por día.
 */
function diasConLugar(esp, profesionales, desde, hasta, franja, ctx) {
  const dias = [];
  let cursor = RS.fechaDeIso(desde);
  const fin = RS.fechaDeIso(hasta);
  while (cursor.getTime() <= fin.getTime()) {
    const fecha = RS.isoDe(cursor);
    const slots = [];
    for (const prof of profesionales) {
      if (slots.length >= POR_DIA_MAX) break;
      if (!RS.atiende(prof, fecha)) continue;
      for (const hora of RS.generarHorarios(fecha, esp.dur)) {
        if (slots.length >= POR_DIA_MAX) break;
        if (!enFranja(hora, franja)) continue;
        if (RS.esPasado(fecha, hora, ctx.ahora)) continue;
        if (!horaDisponible(prof, fecha, hora, ctx)) continue;
        slots.push({ esp, prof, fecha, hora });
      }
    }
    if (slots.length) dias.push({ fecha, slots });
    cursor = RS.sumarDias(cursor, 1);
  }
  return dias;
}

/** Reparte los cupos en días distintos antes de repetir día. */
function repartirEnDias(dias, maximo) {
  const salida = [];
  const copias = dias.map((d) => d.slots.slice());
  let quedan = true;
  while (salida.length < maximo && quedan) {
    quedan = false;
    for (const lista of copias) {
      if (!lista.length) continue;
      quedan = true;
      salida.push(lista.shift());
      if (salida.length >= maximo) break;
    }
  }
  return salida;
}

function motivoVacio(esp, profesionales, desde, hasta, ctx) {
  let cerrados = 0;
  let sinAtencion = 0;
  let total = 0;
  let cursor = RS.fechaDeIso(desde);
  const fin = RS.fechaDeIso(hasta);
  while (cursor.getTime() <= fin.getTime()) {
    const fecha = RS.isoDe(cursor);
    total += 1;
    if (RS.fechaDeIso(fecha).getDay() === 0 || RS.esFeriado(fecha)) cerrados += 1;
    else if (!profesionales.some((p) => RS.atiende(p, fecha))) sinAtencion += 1;
    cursor = RS.sumarDias(cursor, 1);
  }
  if (!total) return 'El rango de fechas quedó vacío: pedí una fecha desde hoy hasta los próximos 21 días.';
  if (cerrados === total) return 'Esos días el centro está cerrado (domingo o feriado).';
  if (cerrados + sinAtencion === total) {
    return `${esp.nombre} no atiende en los días pedidos (atiende ${RS.diasTexto(profesionales[0].dias)}).`;
  }
  return `No quedan horarios libres de ${esp.nombre} en ese rango de fechas.`;
}

/**
 * `buscar_disponibilidad`: hasta 6 slots repartidos en días distintos.
 * Devuelve `{ slots }` o `{ slots: [], motivo, proximo_dia }`.
 */
function buscarDisponibilidad(entrada, ctxCrudo) {
  const ctx = contextoNormalizado(ctxCrudo);
  const esp = especialidadPorId(entrada.especialidad);
  if (!esp) return { slots: [], motivo: 'Especialidad desconocida.' };

  const profesionales = profesionalesDe(esp, entrada.profesional);
  if (!profesionales.length) {
    return { slots: [], motivo: `No hay un profesional con el id ${entrada.profesional} en ${esp.nombre}.` };
  }

  const hoy = hoyIso(ctx.ahora);
  const limite = ultimoDiaIso(ctx.ahora);
  const desde = entrada.desde < hoy ? hoy : entrada.desde;
  const hasta = entrada.hasta ? (entrada.hasta > limite ? limite : entrada.hasta) : limite;

  if (desde > limite) {
    return {
      slots: [],
      motivo: `Solo puedo buscar turnos desde hoy (${hoy}) hasta ${limite}.`,
      proximo_dia: null,
    };
  }
  if (hasta < desde) {
    return { slots: [], motivo: 'La fecha "hasta" es anterior a "desde".', proximo_dia: null };
  }

  const franja = entrada.franja || 'cualquiera';
  const dias = diasConLugar(esp, profesionales, desde, hasta, franja, ctx);
  const elegidos = repartirEnDias(dias, MAX_SLOTS);

  if (elegidos.length) {
    return { slots: elegidos.map((s) => describirSlot(s.esp, s.prof, s.fecha, s.hora)) };
  }

  // Sin lugar: buscamos el próximo día con lugar dentro de la ventana completa.
  const resto = desde < hoy ? hoy : desde;
  const otros = diasConLugar(esp, profesionales, resto, limite, franja, ctx);
  return {
    slots: [],
    motivo: motivoVacio(esp, profesionales, desde, hasta, ctx),
    proximo_dia: otros.length ? otros[0].fecha : null,
  };
}

/**
 * Revalida un slot antes de proponerlo: existe, cae en la ventana, está en la
 * grilla del profesional y sigue libre.
 */
function validarSlotParaReserva(slotIdCrudo, ctxCrudo) {
  const ctx = contextoNormalizado(ctxCrudo);
  const partes = partesDeSlot(slotIdCrudo);
  if (!partes) return { ok: false, motivo: 'El slot_id no tiene el formato <profId>|<YYYY-MM-DD>|<HH:MM>.' };

  const info = RS.profesionalPorId(partes.profId);
  if (!info) return { ok: false, motivo: `No existe el profesional ${partes.profId}.` };
  const { esp, prof } = info;

  if (!dentroDeVentana(partes.fecha, ctx.ahora)) {
    return { ok: false, motivo: `La fecha ${partes.fecha} está fuera de la agenda abierta (hoy a ${ultimoDiaIso(ctx.ahora)}).` };
  }
  if (!RS.atiende(prof, partes.fecha)) {
    return { ok: false, motivo: `${prof.nombre} no atiende ese día (${RS.diasTexto(prof.dias)}).` };
  }
  if (!horaEnGrilla(prof, esp, partes.fecha, partes.hora)) {
    return { ok: false, motivo: `La hora ${partes.hora} no pertenece a la grilla de ${esp.nombre}.` };
  }
  if (RS.esPasado(partes.fecha, partes.hora, ctx.ahora)) {
    return { ok: false, motivo: 'Ese horario ya pasó.' };
  }
  if (!horaDisponible(prof, partes.fecha, partes.hora, ctx)) {
    return { ok: false, motivo: 'Ese horario ya está ocupado. Elegí otro.' };
  }

  return {
    ok: true,
    slot: datosDelTurno(esp, prof, partes.fecha, partes.hora),
    slotModelo: describirSlot(esp, prof, partes.fecha, partes.hora),
    resumen: resumenSlot(esp, prof, partes.fecha, partes.hora),
  };
}

/** Turno propio, cancelable: origen web, futuro y con código válido. */
function buscarTurnoCancelable(codigo, ctxCrudo) {
  const ctx = contextoNormalizado(ctxCrudo);
  if (!FORMATO_CODIGO.test(String(codigo || ''))) {
    return { ok: false, motivo: 'El código tiene que tener el formato RS-XXXX.' };
  }
  const turno = turnoPorCodigo(ctx.turnos, codigo);
  if (!turno) return { ok: false, motivo: `No encuentro el turno ${codigo} en este dispositivo.` };
  if ((turno.origen || 'web') !== 'web') {
    return { ok: false, motivo: `El turno ${codigo} no se puede cancelar desde acá: lo cargó la recepción.` };
  }
  if (RS.esPasado(turno.fecha, turno.hora, ctx.ahora)) {
    return { ok: false, motivo: `El turno ${codigo} ya pasó.` };
  }
  const etiquetas = etiquetasDeTurno(turno);
  return {
    ok: true,
    turno,
    resumen: `${codigo} · ${etiquetas.espNombre} · ${etiquetas.profNombre} · ${RS.formatearFechaLarga(turno.fecha)} ${turno.hora}`,
  };
}

/**
 * Reespecialidad del turno (para reprogramar): usa `espId` o lo deduce del
 * profesional.
 */
function especialidadDelTurno(turno) {
  if (turno.espId && especialidadPorId(turno.espId)) return turno.espId;
  const info = RS.profesionalPorId(turno.profId);
  return info ? info.esp.id : null;
}

module.exports = {
  FORMATO_FECHA,
  FORMATO_HORA,
  FORMATO_SLOT,
  FORMATO_CODIGO,
  MAX_SLOTS,
  esFechaValida,
  esHoraValida,
  hoyIso,
  ultimoDiaIso,
  especialidadPorId,
  partesDeSlot,
  slotId,
  dentroDeVentana,
  describirSlot,
  datosDelTurno,
  resumenSlot,
  turnosDelPaciente,
  turnoPorCodigo,
  etiquetasDeTurno,
  describirTurnoDelPaciente,
  listaTurnosDelPaciente,
  buscarDisponibilidad,
  validarSlotParaReserva,
  buscarTurnoCancelable,
  especialidadDelTurno,
  contextoNormalizado,
};
