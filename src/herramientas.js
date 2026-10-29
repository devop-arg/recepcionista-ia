'use strict';

/**
 * Herramientas del agente: definiciones con JSON Schema estricto + validador
 * propio + despachador.
 *
 * Regla de oro: ninguna herramienta escribe. Validan, y si sale bien devuelven
 * una **acción** para que el paciente la confirme en el navegador.
 */

const RS = require('../vendor/turnero.js');
const agenda = require('./agenda.js');

const ESPECIALIDADES = RS.ESPECIALIDADES.map((e) => e.id);
const MOTIVOS = ['urgencia', 'consulta_medica', 'administrativo', 'otro'];
const FRANJAS = ['manana', 'tarde', 'cualquiera'];

const PATRON_FECHA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const PATRON_SLOT = { type: 'string', pattern: '^[a-z0-9_-]{1,24}\\|\\d{4}-\\d{2}-\\d{2}\\|\\d{2}:\\d{2}$' };
const PATRON_CODIGO = { type: 'string', pattern: '^RS-[A-Z0-9]{4}$' };

const HERRAMIENTAS = [
  {
    name: 'buscar_disponibilidad',
    description:
      'Busca horarios libres reales del turnero. Usala siempre antes de ofrecer un horario. '
      + 'Devuelve hasta 6 opciones (slot_id, especialidad, profesional, fecha, dia, hora) '
      + 'o una lista vacía con el motivo.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        especialidad: {
          type: 'string',
          enum: ESPECIALIDADES,
          description: 'Id de la especialidad.',
        },
        profesional: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Id de profesional para limitar la búsqueda, o null para todos.',
        },
        desde: { ...PATRON_FECHA, description: 'Primer día a mirar, en formato YYYY-MM-DD.' },
        hasta: {
          anyOf: [{ ...PATRON_FECHA }, { type: 'null' }],
          description: 'Último día a mirar (YYYY-MM-DD) o null para el límite de la agenda.',
        },
        franja: {
          type: 'string',
          enum: FRANJAS,
          description: 'manana = antes de las 13:00, tarde = desde las 14:00, cualquiera = sin filtro.',
        },
      },
      required: ['especialidad', 'profesional', 'desde', 'hasta', 'franja'],
      additionalProperties: false,
    },
  },
  {
    name: 'proponer_reserva',
    description:
      'Propone reservar un horario libre. Revalida el slot contra la agenda actual. '
      + 'No reserva: devuelve una tarjeta para que el paciente confirme con sus datos.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        slot_id: { ...PATRON_SLOT, description: 'Identificador <profId>|<YYYY-MM-DD>|<HH:MM> devuelto por buscar_disponibilidad.' },
      },
      required: ['slot_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'proponer_cancelacion',
    description:
      'Propone cancelar un turno del paciente en este dispositivo. Solo turnos sacados por la web y futuros.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        codigo: { ...PATRON_CODIGO, description: 'Código del turno, por ejemplo RS-AB12.' },
      },
      required: ['codigo'],
      additionalProperties: false,
    },
  },
  {
    name: 'proponer_reprogramacion',
    description:
      'Propone pasar un turno del paciente a otro horario libre de la misma especialidad. '
      + 'No reprograma: devuelve una tarjeta para confirmar.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        codigo: { ...PATRON_CODIGO, description: 'Código del turno actual.' },
        slot_id: { ...PATRON_SLOT, description: 'Nuevo horario, devuelto por buscar_disponibilidad.' },
      },
      required: ['codigo', 'slot_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'derivar_a_recepcion',
    description:
      'Deriva a una persona de recepción. Usala para urgencias, temas médicos que no son turnos, '
      + 'recetas, resultados, facturación o cualquier pedido que no puedas resolver.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          enum: MOTIVOS,
          description: 'urgencia, consulta_medica, administrativo u otro.',
        },
        resumen: {
          type: 'string',
          maxLength: 200,
          description: 'Resumen del pedido en una frase, sin nombres, DNI ni teléfonos.',
        },
      },
      required: ['motivo', 'resumen'],
      additionalProperties: false,
    },
  },
];

const NOMBRES = HERRAMIENTAS.map((h) => h.name);

function esTexto(valor) {
  return typeof valor === 'string';
}

function validarUnion(valor, patron, campo, errores) {
  if (valor === null) return null;
  if (!esTexto(valor)) {
    errores.push(`${campo}: se esperaba texto o null.`);
    return undefined;
  }
  if (!new RegExp(patron.pattern).test(valor)) {
    errores.push(`${campo}: formato inválido.`);
    return undefined;
  }
  return valor;
}

/**
 * Valida y normaliza la entrada de una herramienta.
 * Devuelve `{ ok, entrada, errores }`; nunca lanza.
 */
function validarEntrada(nombre, input) {
  const errores = [];
  const datos = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (datos !== input) errores.push('La entrada tiene que ser un objeto JSON.');
  const claves = Object.keys(datos);
  const permitidas = (HERRAMIENTAS.find((h) => h.name === nombre) || { input_schema: { properties: {} } })
    .input_schema.properties;
  for (const clave of claves) {
    if (!Object.prototype.hasOwnProperty.call(permitidas, clave)) errores.push(`Campo desconocido: ${clave}.`);
  }

  const entrada = {};

  if (nombre === 'buscar_disponibilidad') {
    if (!ESPECIALIDADES.includes(datos.especialidad)) errores.push('especialidad: id desconocido.');
    else entrada.especialidad = datos.especialidad;

    if (datos.profesional === null) entrada.profesional = null;
    else if (!esTexto(datos.profesional) || !/^[a-z0-9_-]{1,24}$/.test(datos.profesional)) {
      errores.push('profesional: id inválido o null.');
    } else entrada.profesional = datos.profesional;

    if (!agenda.esFechaValida(datos.desde)) errores.push('desde: fecha YYYY-MM-DD inválida.');
    else entrada.desde = datos.desde;

    if (datos.hasta === null || datos.hasta === undefined) entrada.hasta = null;
    else if (!agenda.esFechaValida(datos.hasta)) errores.push('hasta: fecha YYYY-MM-DD inválida o null.');
    else entrada.hasta = datos.hasta;

    if (datos.franja === undefined) entrada.franja = 'cualquiera';
    else if (!FRANJAS.includes(datos.franja)) errores.push('franja: tiene que ser manana, tarde o cualquiera.');
    else entrada.franja = datos.franja;

    if (entrada.desde && entrada.hasta && entrada.hasta < entrada.desde) {
      errores.push('hasta: no puede ser anterior a desde.');
    }
  }

  if (nombre === 'proponer_reserva') {
    const slot = validarUnion(datos.slot_id, PATRON_SLOT, 'slot_id', errores);
    if (slot && !agenda.partesDeSlot(slot)) errores.push('slot_id: partes inválidas.');
    if (slot) entrada.slot_id = slot;
  }

  if (nombre === 'proponer_cancelacion') {
    const codigo = validarUnion(datos.codigo, PATRON_CODIGO, 'codigo', errores);
    if (codigo) entrada.codigo = codigo;
  }

  if (nombre === 'proponer_reprogramacion') {
    const codigo = validarUnion(datos.codigo, PATRON_CODIGO, 'codigo', errores);
    if (codigo) entrada.codigo = codigo;
    const slot = validarUnion(datos.slot_id, PATRON_SLOT, 'slot_id', errores);
    if (slot && !agenda.partesDeSlot(slot)) errores.push('slot_id: partes inválidas.');
    if (slot) entrada.slot_id = slot;
  }

  if (nombre === 'derivar_a_recepcion') {
    if (!MOTIVOS.includes(datos.motivo)) errores.push('motivo: valor inválido.');
    else entrada.motivo = datos.motivo;
    if (!esTexto(datos.resumen) || !datos.resumen.trim()) errores.push('resumen: texto obligatorio.');
    else if (datos.resumen.length > 200) errores.push('resumen: máximo 200 caracteres.');
    else entrada.resumen = datos.resumen.trim();
  }

  if (!NOMBRES.includes(nombre)) errores.push(`Herramienta desconocida: ${nombre}.`);

  return { ok: errores.length === 0, entrada, errores };
}

/** Una acción por tipo: si el modelo propone dos veces, queda la última. */
function acumularAccion(acciones, accion) {
  const indice = acciones.findIndex((a) => a.tipo === accion.tipo);
  if (indice === -1) acciones.push(accion);
  else acciones[indice] = accion;
  return acciones;
}

/**
 * Ejecuta una herramienta ya validada.
 * Devuelve `{ ok, resultado, accion }`; `resultado` es lo que vuelve como
 * `tool_result`. Los errores de negocio (`ok: false`) viajan con `is_error`.
 */
function despachar(nombre, entrada, ctx) {
  if (nombre === 'buscar_disponibilidad') {
    const r = agenda.buscarDisponibilidad(entrada, ctx);
    if (!r.slots.length) {
      return {
        ok: true,
        resultado: { slots: [], motivo: r.motivo, proximo_dia: r.proximo_dia || null },
      };
    }
    return { ok: true, resultado: { slots: r.slots } };
  }

  if (nombre === 'proponer_reserva') {
    const r = agenda.validarSlotParaReserva(entrada.slot_id, ctx);
    if (!r.ok) return { ok: false, resultado: { ok: false, motivo: r.motivo } };
    return {
      ok: true,
      resultado: { ok: true, resumen: r.resumen, slot_id: entrada.slot_id },
      accion: { tipo: 'reservar', slot: r.slot, resumen: r.resumen },
    };
  }

  if (nombre === 'proponer_cancelacion') {
    const r = agenda.buscarTurnoCancelable(entrada.codigo, ctx);
    if (!r.ok) return { ok: false, resultado: { ok: false, motivo: r.motivo } };
    return {
      ok: true,
      resultado: { ok: true, resumen: r.resumen, codigo: entrada.codigo },
      accion: { tipo: 'cancelar', codigo: entrada.codigo, resumen: r.resumen },
    };
  }

  if (nombre === 'proponer_reprogramacion') {
    const turno = agenda.buscarTurnoCancelable(entrada.codigo, ctx);
    if (!turno.ok) return { ok: false, resultado: { ok: false, motivo: turno.motivo } };
    const slot = agenda.validarSlotParaReserva(entrada.slot_id, ctx);
    if (!slot.ok) return { ok: false, resultado: { ok: false, motivo: slot.motivo } };

    const espActual = agenda.especialidadDelTurno(turno.turno);
    if (espActual && espActual !== slot.slot.espId) {
      return {
        ok: false,
        resultado: {
          ok: false,
          motivo: `El turno ${entrada.codigo} es de otra especialidad: un cambio de especialidad es una reserva nueva.`,
        },
      };
    }
    return {
      ok: true,
      resultado: {
        ok: true,
        resumen: `De ${turno.resumen} a ${slot.resumen}`,
        codigo: entrada.codigo,
        slot_id: entrada.slot_id,
      },
      accion: {
        tipo: 'reprogramar',
        codigo: entrada.codigo,
        slot: slot.slot,
        resumen: `${turno.resumen} → ${slot.resumen}`,
      },
    };
  }

  if (nombre === 'derivar_a_recepcion') {
    return {
      ok: true,
      resultado: { ok: true, derivado: entrada.motivo },
      accion: { tipo: 'derivar', motivo: entrada.motivo, resumen: entrada.resumen },
    };
  }

  return { ok: false, resultado: { ok: false, motivo: `Herramienta desconocida: ${nombre}.` } };
}

module.exports = {
  HERRAMIENTAS,
  NOMBRES,
  ESPECIALIDADES,
  MOTIVOS,
  FRANJAS,
  validarEntrada,
  despachar,
  acumularAccion,
};
