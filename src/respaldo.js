'use strict';

/**
 * Modo respaldo: respuesta determinista, sin IA.
 *
 * Se usa cuando falta la clave, se agotó el tope del mes, la API falló, el modelo
 * se negó o el bucle de herramientas se pasó de llamadas. No inventa horarios:
 * las opciones salen de `RS.primerTurnoDeEspecialidad` con la agenda real.
 */

const RS = require('../vendor/turnero.js');
const agenda = require('./agenda.js');

const TEXTO = {
  es: 'El asistente con IA no está disponible en este momento. Podés sacar tu turno desde el turnero.',
  en: 'The AI assistant is not available right now. You can book your appointment from the booking page.',
};

const PALABRAS_INGLES = /\b(i|i'm|im|need|want|would|can|could|please|appointment|booking|doctor|next|week|month|monday|tuesday|wednesday|thursday|friday|saturday|morning|afternoon|hello|hi|hey|cancel|thanks|thank|you|my|the|with|for|is|are|do|does|have|has|any|available)\b/gi;
const PALABRAS_ESPANOL = /\b(necesito|quiero|quisiera|turno|turnos|hola|buenas|gracias|podés|podes|tenés|tenes|cancelar|cancelá|sacar|sacá|con|para|por|una|uno|el|la|los|las|mi|mis|es|hay|qué|que|cómo|como|cuándo|cuando|mañana|tarde|semana|obra|social)\b/gi;

// Sinónimos simples: alcanzan para el modo respaldo (la IA no está disponible).
const SINONIMOS = [
  { esp: 'cardiologia', palabras: ['cardiolog', 'cardio', 'corazon', 'heart'] },
  { esp: 'pediatria', palabras: ['pediatr', 'pediatra', 'nene', 'nena', 'bebe', 'bebé', 'hijo', 'hija'] },
  { esp: 'dermatologia', palabras: ['dermatolog', 'dermato', 'piel', 'skin'] },
  { esp: 'ginecologia', palabras: ['ginecolog', 'gineco', 'gine', 'papanicolau'] },
  { esp: 'traumatologia', palabras: ['traumatolog', 'trauma', 'rodilla', 'espalda', 'hombro'] },
  { esp: 'oftalmologia', palabras: ['oftalmolog', 'oftalmo', 'oculista', 'vista', 'ojos', 'anteojos'] },
  { esp: 'clinica', palabras: ['clinica', 'clínica', 'clinico', 'clínico', 'medico clinico', 'general'] },
];

function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function contar(texto, patron) {
  const m = String(texto || '').match(patron);
  return m ? m.length : 0;
}

/** Heurística de idioma sobre el último mensaje del paciente. */
function pareceIngles(texto) {
  const plano = normalizar(texto);
  if (!plano.trim()) return false;
  return contar(plano, PALABRAS_INGLES) > contar(plano, PALABRAS_ESPANOL);
}

function idiomaDe(historial) {
  const ultimo = [...(historial || [])].reverse().find((m) => m && m.rol === 'paciente');
  return ultimo && pareceIngles(ultimo.texto) ? 'en' : 'es';
}

function textoDeRespaldo(idioma) {
  return TEXTO[idioma === 'en' ? 'en' : 'es'];
}

function ultimoTextoDelPaciente(historial) {
  const ultimo = [...(historial || [])].reverse().find((m) => m && m.rol === 'paciente');
  return ultimo ? String(ultimo.texto || '') : '';
}

/** Especialidades nombradas por nombre, id o sinónimo simple. */
function especialidadesMencionadas(texto) {
  const plano = normalizar(texto);
  const encontradas = [];
  for (const esp of RS.ESPECIALIDADES) {
    const nombre = normalizar(esp.nombre);
    if (plano.includes(nombre) || plano.includes(esp.id)) {
      encontradas.push(esp);
      continue;
    }
    const regla = SINONIMOS.find((s) => s.esp === esp.id);
    if (regla && regla.palabras.some((p) => plano.includes(normalizar(p)))) encontradas.push(esp);
  }
  return encontradas;
}

function opcionesDe(especialidades, ctx) {
  const opciones = [];
  for (const esp of especialidades.slice(0, 3)) {
    const turno = RS.primerTurnoDeEspecialidad(esp, ctx.turnos, ctx.ahora, ctx.gestion);
    if (!turno) continue;
    opciones.push(agenda.describirSlot(turno.esp, turno.prof, turno.fecha, turno.hora));
  }
  return opciones;
}

/**
 * Respuesta de respaldo.
 * `{ respuesta, acciones }` con la acción `turnero` y, si se nombró una
 * especialidad, hasta 3 opciones reales.
 */
function respuestaDeRespaldo({ historial = [], turnos = [], gestion = {}, ahora = new Date() } = {}) {
  const idioma = idiomaDe(historial);
  const ctx = { turnos, gestion, ahora: ahora instanceof Date ? ahora : new Date() };
  const acciones = [{ tipo: 'turnero' }];

  const mencionadas = especialidadesMencionadas(ultimoTextoDelPaciente(historial));
  if (mencionadas.length) {
    const slots = opcionesDe(mencionadas, ctx);
    if (slots.length) acciones.push({ tipo: 'opciones', slots });
  }

  return { respuesta: textoDeRespaldo(idioma), acciones };
}

module.exports = {
  TEXTO,
  pareceIngles,
  idiomaDe,
  textoDeRespaldo,
  normalizar,
  especialidadesMencionadas,
  respuestaDeRespaldo,
};
