'use strict';

/**
 * Modelo simulado: implementa la misma interfaz neutral que el cliente real
 * (`completar({ sistema, herramientas, mensajes })`) sin red ni clave.
 *
 * Sirve para las pruebas y para la demo offline: responde por palabras clave del
 * último mensaje del paciente y sigue un guion de dos pasos (buscar → proponer)
 * igual que un modelo con herramientas.
 */

const RS = require('../../vendor/turnero.js');
const { especialidadesMencionadas } = require('../respaldo.js');

const USO_FIJO = Object.freeze({
  entrada: 1800,
  salida: 120,
  cache_w: 0,
  cache_r: 1200,
});

const PATRON_CONTEXTO = /<contexto>([\s\S]*?)<\/contexto>/;
const PATRON_CODIGO = /\bRS-[A-Z0-9]{4}\b/;

function textoDe(mensaje) {
  if (!mensaje) return '';
  return String(mensaje.texto == null ? '' : mensaje.texto);
}

/** Último mensaje del paciente con texto. */
function ultimoTextoPaciente(mensajes) {
  for (let i = mensajes.length - 1; i >= 0; i -= 1) {
    const m = mensajes[i];
    if (!m || m.rol !== 'usuario') continue;
    const texto = textoDe(m);
    if (texto.trim()) return texto;
  }
  return '';
}

function contextoDe(mensajes) {
  const todo = mensajes.map(textoDe).join('\n');
  const m = PATRON_CONTEXTO.exec(todo);
  return m ? m[1] : '';
}

function sinContexto(texto) {
  return String(texto || '')
    .replace(PATRON_CONTEXTO, ' ')
    .replace(/Fecha y hora actual:[^\n]*/g, ' ')
    .replace(/Turnos del paciente en este dispositivo:[^\n]*/g, ' ')
    .trim();
}

function herramientasUsadas(mensajes) {
  const usadas = [];
  for (const m of mensajes) {
    if (!m || m.rol !== 'asistente' || !Array.isArray(m.llamadas)) continue;
    for (const llamada of m.llamadas) usadas.push(llamada.nombre);
  }
  return usadas;
}

/** Resultados de herramientas ya ejecutadas, con el nombre de cada una. */
function resultadosDe(mensajes) {
  const nombres = new Map();
  for (const m of mensajes) {
    if (!m || m.rol !== 'asistente' || !Array.isArray(m.llamadas)) continue;
    for (const llamada of m.llamadas) nombres.set(llamada.id, llamada.nombre);
  }

  const salida = [];
  for (const m of mensajes) {
    if (!m || m.rol !== 'resultados' || !Array.isArray(m.resultados)) continue;
    for (const resultado of m.resultados) {
      let datos = null;
      if (typeof resultado.contenido === 'string') {
        try {
          datos = JSON.parse(resultado.contenido);
        } catch {
          datos = { texto: resultado.contenido };
        }
      } else {
        datos = resultado.contenido;
      }
      salida.push({ nombre: nombres.get(resultado.id) || '', datos, error: resultado.error === true });
    }
  }
  return salida;
}

function franjaDe(texto) {
  const plano = texto.toLowerCase();
  if (/tarde|afternoon/.test(plano)) return 'tarde';
  if (/mañana|manana|morning/.test(plano)) return 'manana';
  return 'cualquiera';
}

/** Decisión del guion: devuelve `{ texto, llamadas }`. */
function decidir({ texto, contexto, usadas, resultados, ahora, contador }) {
  const limpio = sinContexto(texto);
  const plano = limpio.toLowerCase();
  const yaHizo = (nombre) => usadas.includes(nombre);
  const resultadoDe = (nombre) => [...resultados].reverse().find((r) => r.nombre === nombre);
  const pedir = (nombre, entrada) => ({
    texto: '',
    llamadas: [{ id: `call_sim_${contador()}`, nombre, entrada }],
  });

  // 1. Urgencia.
  if (/pecho|urgente|urgencia|falta de aire|desmay|sangrado|acv|hacerme dano|hacerme daño/.test(plano)) {
    if (!yaHizo('derivar_a_recepcion')) {
      return pedir('derivar_a_recepcion', {
        motivo: 'urgencia',
        resumen: 'El paciente describe un posible cuadro de urgencia.',
      });
    }
    return {
      texto: 'Si es una emergencia, llamá al 107 (SAME) o al 911, o acercate a la guardia más cercana.',
      llamadas: [],
    };
  }

  // 2. Recetas y trámites: a recepción.
  if (/receta|resultado|factura|certificado/.test(plano)) {
    if (!yaHizo('derivar_a_recepcion')) {
      return pedir('derivar_a_recepcion', {
        motivo: 'consulta_medica',
        resumen: 'El paciente pide una receta o un trámite que resuelve recepción.',
      });
    }
    return { texto: 'Ese pedido lo resuelve recepción. Te dejo la tarjeta para escribirles.', llamadas: [] };
  }

  // 3. Cancelación del turno guardado en el dispositivo.
  if (/cancel/.test(plano)) {
    const codigo = (PATRON_CODIGO.exec(contexto) || [null])[0];
    if (!codigo) {
      return {
        texto: 'No veo turnos guardados en este dispositivo. Si querés, te ayudo a sacar uno nuevo.',
        llamadas: [],
      };
    }
    if (!yaHizo('proponer_cancelacion')) return pedir('proponer_cancelacion', { codigo });
    return {
      texto: `Preparé la cancelación del turno ${codigo}. Confirmala en la tarjeta y liberamos el horario.`,
      llamadas: [],
    };
  }

  // 4. Especialidad nombrada: buscar y después proponer el primer horario.
  const esp = especialidadesMencionadas(limpio)[0];

  if (esp && !yaHizo('buscar_disponibilidad')) {
    return pedir('buscar_disponibilidad', {
      especialidad: esp.id,
      profesional: null,
      desde: RS.isoDe(ahora()),
      hasta: null,
      franja: franjaDe(plano),
    });
  }

  if (esp && !yaHizo('proponer_reserva')) {
    const busqueda = resultadoDe('buscar_disponibilidad');
    const slots = (busqueda && busqueda.datos && Array.isArray(busqueda.datos.slots)) ? busqueda.datos.slots : [];
    if (!slots.length) {
      const motivo = (busqueda && busqueda.datos && busqueda.datos.motivo) || 'No hay horarios libres en esas fechas.';
      return { texto: `${motivo} ¿Querés que mire otra semana?`, llamadas: [] };
    }
    return pedir('proponer_reserva', { slot_id: slots[0].slot_id });
  }

  if (esp) {
    const reserva = resultadoDe('proponer_reserva');
    const busqueda = resultadoDe('buscar_disponibilidad');
    const slot = busqueda && busqueda.datos && busqueda.datos.slots ? busqueda.datos.slots[0] : null;
    if (reserva && reserva.datos && reserva.datos.ok && slot) {
      return {
        texto: `Te preparé el turno de ${slot.especialidad} con ${slot.profesional} el ${slot.dia} a las ${slot.hora}. `
          + 'Confirmalo en la tarjeta y queda agendado.',
        llamadas: [],
      };
    }
    return { texto: 'No pude preparar esa reserva. ¿Querés probar con otro horario?', llamadas: [] };
  }

  // 5. Sin datos suficientes.
  return {
    texto: '¿Para qué especialidad necesitás el turno? Podés pedir clínica médica, cardiología, pediatría, '
      + 'dermatología, ginecología, traumatología u oftalmología.',
    llamadas: [],
  };
}

/**
 * Crea el modelo falso. `pedidos` acumula los parámetros recibidos para que las
 * pruebas puedan inspeccionarlos.
 */
function crearModeloSimulado({ ahora = () => new Date(), uso = USO_FIJO } = {}) {
  const pedidos = [];
  let contador = 0;
  const numerar = () => {
    contador += 1;
    return contador;
  };

  function completar({ mensajes } = {}) {
    const lista = Array.isArray(mensajes) ? mensajes : [];
    pedidos.push({ mensajes: lista });
    const decision = decidir({
      texto: ultimoTextoPaciente(lista),
      contexto: contextoDe(lista),
      usadas: herramientasUsadas(lista),
      resultados: resultadosDe(lista),
      ahora,
      contador: numerar,
    });
    return Promise.resolve({
      texto: decision.texto,
      llamadas: decision.llamadas,
      fin: decision.llamadas.length ? 'herramientas' : 'fin',
      fin_crudo: decision.llamadas.length ? 'tool_calls' : 'fin',
      uso: { ...uso },
      extra: null,
      crudo: null,
    });
  }

  return { nombre: 'simulado', modelo: 'simulado', pedidos, completar };
}

module.exports = {
  crearModeloSimulado,
  decidir,
  USO_FIJO,
  ultimoTextoPaciente,
  contextoDe,
  sinContexto,
  herramientasUsadas,
  resultadosDe,
};
