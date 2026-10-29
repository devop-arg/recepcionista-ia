'use strict';

/**
 * Bucle del agente: arma los mensajes en un formato neutral, llama al cliente de
 * modelo configurado, ejecuta las herramientas propuestas y devuelve texto +
 * acciones + traza. No conoce la API de ningún modelo: eso vive en `src/modelo/`.
 *
 * Nunca escribe: las herramientas de `src/herramientas.js` solo producen
 * acciones, y el turno se guarda cuando el paciente confirma en el navegador.
 */

const RS = require('../vendor/turnero.js');
const agendaModulo = require('./agenda.js');
const configModulo = require('./config.js');
const guardas = require('./guardas.js');
const herramientas = require('./herramientas.js');
const { PROMPT_SISTEMA } = require('./prompt.js');
const { costoDe, sumarUso } = require('./precios.js');
const modeloModulo = require('./modelo/index.js');
const { clasificarError } = require('./modelo/errores.js');
const respaldo = require('./respaldo.js');

const CONFIG_POR_DEFECTO = configModulo.cargarConfig({});

function fechaLarga(ahora) {
  const d = ahora;
  return `${RS.DIAS_LARGOS[d.getDay()]} ${d.getDate()} de ${RS.MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

function horaCorta(ahora) {
  return RS.pad2(ahora.getHours()) + ':' + RS.pad2(ahora.getMinutes());
}

/** Bloque `<contexto>`: lo único variable del pedido, fuera del prompt del sistema. */
function construirContexto({ ahora, turnos }) {
  return [
    '<contexto>',
    `Fecha y hora actual: ${fechaLarga(ahora)}, ${horaCorta(ahora)} (${configModulo.ZONA_HORARIA})`,
    `Turnos del paciente en este dispositivo: ${agendaModulo.listaTurnosDelPaciente(turnos, ahora)}`,
    '</contexto>',
  ].join('\n');
}

/**
 * Historial visible → mensajes neutrales.
 * Une roles consecutivos, descarta el primer turno del asistente y antepone el
 * contexto al último mensaje del paciente.
 *
 * Formato: `{ rol: 'usuario'|'asistente', texto }`, `{ rol: 'asistente', texto,
 * llamadas }` y `{ rol: 'resultados', resultados: [{ id, contenido, error }] }`.
 */
function construirMensajes(historial, { ahora = new Date(), turnos = [] } = {}) {
  const mensajes = [];
  for (const m of historial || []) {
    if (!m || !m.texto) continue;
    const rol = m.rol === 'asistente' ? 'asistente' : 'usuario';
    const ultimo = mensajes[mensajes.length - 1];
    if (ultimo && ultimo.rol === rol) ultimo.texto += `\n${m.texto}`;
    else mensajes.push({ rol, texto: String(m.texto) });
  }
  if (mensajes.length && mensajes[0].rol === 'asistente') mensajes.shift();
  if (!mensajes.length) return mensajes;

  const ultimo = mensajes[mensajes.length - 1];
  if (ultimo.rol === 'usuario') {
    ultimo.texto = `${construirContexto({ ahora, turnos })}\n\n${ultimo.texto}`;
  }
  return mensajes;
}

function contenidoDe(resultado) {
  if (typeof resultado === 'string') return resultado;
  if (resultado === undefined || resultado === null) return 'null';
  return JSON.stringify(resultado);
}

/**
 * Ejecuta una llamada de herramienta validando la entrada con nuestro propio
 * validador. Devuelve el resultado neutral `{ id, contenido, error }`.
 *
 * Una llamada puede venir ya marcada con `error` por el adaptador (argumentos
 * que no eran JSON válido): en ese caso no se ejecuta nada y el modelo recibe
 * el motivo para corregir.
 */
function ejecutarHerramienta(llamada, ctx, acciones, traza) {
  const id = llamada && llamada.id ? String(llamada.id) : '';
  const nombre = String((llamada && llamada.nombre) || '');

  if (llamada && llamada.error) {
    traza.push({ herramienta: nombre, entrada: {}, ok: false });
    return {
      id,
      contenido: JSON.stringify({ error: llamada.motivo || 'Los argumentos de la herramienta no son válidos.' }),
      error: true,
    };
  }

  const entradaCruda = llamada ? llamada.entrada : null;
  const validacion = herramientas.validarEntrada(nombre, entradaCruda);
  if (!validacion.ok) {
    traza.push({
      herramienta: nombre,
      entrada: entradaCruda && typeof entradaCruda === 'object' ? entradaCruda : {},
      ok: false,
    });
    return {
      id,
      contenido: JSON.stringify({ error: validacion.errores.join(' ') }),
      error: true,
    };
  }

  const salida = herramientas.despachar(nombre, validacion.entrada, ctx);
  traza.push({ herramienta: nombre, entrada: validacion.entrada, ok: salida.ok });
  if (salida.ok && salida.accion) herramientas.acumularAccion(acciones, salida.accion);

  return { id, contenido: contenidoDe(salida.resultado), error: !salida.ok };
}

function resultadoRespaldo({ historial, turnos, gestion, ahora, acciones, traza }) {
  const r = respaldo.respuestaDeRespaldo({ historial, turnos, gestion, ahora });
  return {
    respuesta: r.respuesta,
    acciones: acciones.length ? acciones : r.acciones,
    traza,
    modo: 'respaldo',
    llamadas: 0,
    tokens: { entrada: 0, salida: 0, cache_w: 0, cache_r: 0 },
    usd: 0,
    stopReason: null,
    error: null,
  };
}

/**
 * Un turno de conversación.
 *
 * `{ cliente, historial, agenda: { turnos, gestion }, ahora, config }`
 * → `{ respuesta, acciones, traza, modo, llamadas, tokens, usd, stopReason, error }`
 */
async function atenderTurno(opciones = {}) {
  const cfg = opciones.config || CONFIG_POR_DEFECTO;
  const ahora = opciones.ahora instanceof Date ? opciones.ahora : new Date();
  const maxLlamadas = cfg.maxLlamadasPorTurno || 4;

  // Saneo defensivo: aunque el servidor ya lo hizo, el agente no confía.
  const historialSaneado = guardas.sanearHistorial(opciones.historial || [], {
    maxMensajes: cfg.maxMensajesHistorial || 12,
    maxLargoTexto: cfg.maxLargoTexto || 600,
    maxLargoUltimoTexto: cfg.maxLargoUltimoTexto || 500,
  });
  const agendaSaneada = guardas.sanearAgenda(opciones.agenda || {}, {
    maxTurnos: cfg.maxTurnosAgenda || 300,
    maxEntradasGestion: cfg.maxEntradasGestion || 300,
  });

  const ctx = {
    turnos: agendaSaneada.ok ? agendaSaneada.turnos : [],
    gestion: agendaSaneada.ok ? agendaSaneada.gestion : {},
    ahora,
  };
  const acciones = [];
  const traza = [];
  let llamadas = 0;
  let tokens = { entrada: 0, salida: 0, cache_w: 0, cache_r: 0 };
  let usd = 0;
  let stopReason = null;

  if (!historialSaneado.ok) {
    return {
      respuesta: respaldo.textoDeRespaldo('es'),
      acciones: respaldo.respuestaDeRespaldo({ historial: [], ...ctx }).acciones,
      traza,
      modo: 'respaldo',
      llamadas: 0,
      tokens,
      usd,
      stopReason: null,
      error: 'historial_invalido',
    };
  }

  const mensajes = construirMensajes(historialSaneado.historial, { ahora, turnos: ctx.turnos });
  if (!mensajes.length) {
    return {
      respuesta: respaldo.textoDeRespaldo('es'),
      acciones: respaldo.respuestaDeRespaldo({ historial: historialSaneado.historial, ...ctx }).acciones,
      traza,
      modo: 'respaldo',
      llamadas: 0,
      tokens,
      usd,
      stopReason: null,
      error: null,
    };
  }

  const cliente = modeloModulo.resolverCliente({
    cliente: opciones.cliente,
    config: cfg,
    opciones: {
      ahora: () => ahora,
      fetch: opciones.fetch,
      esperar: opciones.esperar,
    },
  });

  while (llamadas < maxLlamadas) {
    llamadas += 1;

    let respuesta;
    try {
      respuesta = await cliente.completar({
        sistema: PROMPT_SISTEMA,
        herramientas: herramientas.HERRAMIENTAS,
        // Copia: el bucle sigue agregando mensajes y el pedido debe quedar inmutable.
        mensajes: mensajes.map((m) => ({ ...m })),
      });
    } catch (error) {
      return {
        ...resultadoRespaldo({
          historial: historialSaneado.historial,
          ...ctx,
          acciones,
          traza,
        }),
        llamadas,
        tokens,
        usd,
        stopReason: null,
        error: clasificarError(error),
      };
    }

    tokens = sumarUso(tokens, respuesta.uso);
    usd = Math.round((usd + costoDe(respuesta.uso, cfg.precios)) * 1e6) / 1e6;
    stopReason = respuesta.fin_crudo || respuesta.fin || null;

    if (respuesta.fin === 'rechazo' || respuesta.fin === 'limite') {
      return {
        ...resultadoRespaldo({ historial: historialSaneado.historial, ...ctx, acciones, traza }),
        llamadas,
        tokens,
        usd,
        stopReason,
        error: stopReason,
      };
    }

    const pedidas = Array.isArray(respuesta.llamadas) ? respuesta.llamadas : [];

    if (pedidas.length) {
      if (llamadas >= maxLlamadas) {
        return {
          ...resultadoRespaldo({ historial: historialSaneado.historial, ...ctx, acciones, traza }),
          llamadas,
          tokens,
          usd,
          stopReason,
          error: 'limite_llamadas',
        };
      }

      mensajes.push({
        rol: 'asistente',
        texto: respuesta.texto || '',
        llamadas: pedidas,
        extra: respuesta.extra || null,
      });
      const resultados = pedidas.map((llamada) => ejecutarHerramienta(llamada, ctx, acciones, traza));
      // Todos los resultados de una misma respuesta viajan juntos, en orden.
      mensajes.push({ rol: 'resultados', resultados });
      continue;
    }

    const texto = String(respuesta.texto || '').trim();
    if (!texto) {
      return {
        ...resultadoRespaldo({ historial: historialSaneado.historial, ...ctx, acciones, traza }),
        llamadas,
        tokens,
        usd,
        stopReason,
        error: 'respuesta_vacia',
      };
    }

    return {
      respuesta: texto,
      acciones,
      traza,
      modo: 'ia',
      llamadas,
      tokens,
      usd,
      stopReason,
      error: null,
    };
  }

  return {
    ...resultadoRespaldo({ historial: historialSaneado.historial, ...ctx, acciones, traza }),
    llamadas,
    tokens,
    usd,
    stopReason,
    error: 'limite_llamadas',
  };
}

module.exports = {
  atenderTurno,
  construirMensajes,
  construirContexto,
  ejecutarHerramienta,
  clasificarError,
};
