'use strict';

/**
 * Cliente de modelo compatible con OpenAI: `POST {base}/chat/completions`.
 *
 * `fetch` nativo, sin dependencias. Traduce el formato neutral de mensajes al
 * de Chat Completions, reintenta una vez los errores recuperables (429, 5xx,
 * "capacity") y devuelve un error tipado cuando no hay forma de seguir: el
 * servidor responde en modo respaldo. La clave y los cuerpos nunca se loguean.
 */

const { ModeloAuth, ModeloNoDisponible } = require('./errores.js');

const TIMEOUT_MS = 30000;
const ESPERA_REINTENTO_MS = 1500;
const MAX_TOKENS_SALIDA = 2048;

const FIN = Object.freeze({
  tool_calls: 'herramientas',
  stop: 'fin',
  length: 'limite',
  content_filter: 'rechazo',
});

function finDeOpenAI(finishReason, llamadas) {
  if (FIN[finishReason]) return FIN[finishReason];
  return llamadas.length ? 'herramientas' : 'fin';
}

/** Herramientas internas (JSON Schema) → `{ type: "function", function: { … } }`. */
function herramientasDe(definiciones) {
  return (definiciones || []).map((herramienta) => ({
    type: 'function',
    function: {
      name: herramienta.name,
      description: herramienta.description,
      parameters: herramienta.input_schema,
    },
  }));
}

function argumentosDe(llamada) {
  // Si un turno anterior trajo argumentos ilegibles, se reenvían tal cual: el
  // modelo tiene que ver el mismo texto que produjo para poder corregirlo.
  if (typeof llamada.entrada_cruda === 'string') return llamada.entrada_cruda;
  const entrada = llamada.entrada && typeof llamada.entrada === 'object' ? llamada.entrada : {};
  return JSON.stringify(entrada);
}

function contenidoDe(resultado) {
  if (typeof resultado === 'string') return resultado;
  if (resultado === undefined || resultado === null) return 'null';
  return JSON.stringify(resultado);
}

/** Mensajes neutrales → mensajes de Chat Completions. */
function mensajesDe(mensajes) {
  const salida = [];
  for (const mensaje of mensajes || []) {
    if (!mensaje) continue;

    if (mensaje.rol === 'usuario') {
      salida.push({ role: 'user', content: String(mensaje.texto == null ? '' : mensaje.texto) });
      continue;
    }

    if (mensaje.rol === 'asistente') {
      const salidaMensaje = { role: 'assistant', content: mensaje.texto || null };
      if (Array.isArray(mensaje.llamadas) && mensaje.llamadas.length) {
        salidaMensaje.tool_calls = mensaje.llamadas.map((llamada) => ({
          id: llamada.id,
          type: 'function',
          function: { name: llamada.nombre, arguments: argumentosDe(llamada) },
        }));
      }
      // Algunos modelos exigen devolver el razonamiento del turno cuando se
      // encadenan herramientas. Solo viaja en los mensajes que lo trajeron.
      const razonamiento = mensaje.extra && mensaje.extra.reasoning_content;
      if (typeof razonamiento === 'string' && razonamiento) {
        salidaMensaje.reasoning_content = razonamiento;
      }
      salida.push(salidaMensaje);
      continue;
    }

    if (mensaje.rol === 'resultados') {
      // Un mensaje `tool` por resultado, en el mismo orden en que se pidieron.
      for (const resultado of mensaje.resultados || []) {
        salida.push({
          role: 'tool',
          tool_call_id: resultado.id,
          content: contenidoDe(resultado.contenido),
        });
      }
    }
  }
  return salida;
}

/** `tool_calls[]` de la respuesta → llamadas neutrales. */
function llamadasDe(mensajeCrudo) {
  const crudas = Array.isArray(mensajeCrudo && mensajeCrudo.tool_calls) ? mensajeCrudo.tool_calls : [];
  const llamadas = [];

  crudas.forEach((llamada, indice) => {
    const funcion = (llamada && llamada.function) || {};
    const id = typeof llamada.id === 'string' && llamada.id ? llamada.id : `call_${indice}`;
    const nombre = typeof funcion.name === 'string' ? funcion.name : '';
    const argumentos = funcion.arguments;

    let entrada = {};
    if (typeof argumentos === 'string') {
      let parseado;
      try {
        parseado = JSON.parse(argumentos);
      } catch {
        parseado = undefined;
      }
      if (!parseado || typeof parseado !== 'object' || Array.isArray(parseado)) {
        // Error recuperable: el agente devuelve un resultado con error y el
        // modelo vuelve a intentar con argumentos válidos.
        llamadas.push({
          id,
          nombre,
          entrada: {},
          entrada_cruda: argumentos,
          error: true,
          motivo: 'Los argumentos de la herramienta no son un objeto JSON válido.',
        });
        return;
      }
      entrada = parseado;
    } else if (argumentos && typeof argumentos === 'object' && !Array.isArray(argumentos)) {
      entrada = argumentos;
    }

    llamadas.push({ id, nombre, entrada });
  });

  return llamadas;
}

function usoDe(usage) {
  const u = usage || {};
  const detalles = u.prompt_tokens_details || {};
  const numero = (valor) => (Number.isFinite(Number(valor)) && Number(valor) > 0 ? Number(valor) : 0);
  return {
    entrada: numero(u.prompt_tokens),
    salida: numero(u.completion_tokens),
    cache_w: 0,
    cache_r: numero(detalles.cached_tokens),
  };
}

function textoDe(contenido) {
  if (typeof contenido === 'string') return contenido;
  if (Array.isArray(contenido)) {
    return contenido
      .filter((parte) => parte && typeof parte.text === 'string')
      .map((parte) => parte.text)
      .join('');
  }
  return '';
}

function crearModelo({
  config = {},
  fetch: fetchImpl = null,
  esperar = null,
  baseUrl = null,
  clave = null,
} = {}) {
  const modelo = config.modelo || '';
  const urlBase = String(baseUrl === null ? config.baseUrl || '' : baseUrl).replace(/\/+$/, '');
  const apiKey = clave === null ? config.apiKey || '' : clave;
  const maxTokensSalida = config.maxTokensSalida || MAX_TOKENS_SALIDA;
  const hacerFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const dormir = esperar || ((ms) => new Promise((resolver) => {
    const t = setTimeout(resolver, ms);
    if (typeof t.unref === 'function') t.unref();
  }));

  async function enviar(cuerpo) {
    if (!urlBase) throw new ModeloNoDisponible('Falta la URL base del servicio de modelo.');
    if (!apiKey) throw new ModeloNoDisponible('Falta la clave del servicio de modelo.');

    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), TIMEOUT_MS);
    if (typeof temporizador.unref === 'function') temporizador.unref();

    let respuesta;
    try {
      respuesta = await hacerFetch(`${urlBase}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      });
    } catch {
      throw new ModeloNoDisponible('No se pudo conectar con el servicio de modelo.');
    } finally {
      clearTimeout(temporizador);
    }

    let crudo = '';
    try {
      crudo = await respuesta.text();
    } catch {
      crudo = '';
    }

    const estado = Number(respuesta.status);
    if (estado === 401 || estado === 403) throw new ModeloAuth();

    const exitoso = respuesta.ok === true || (Number.isFinite(estado) && estado >= 200 && estado < 300);
    if (!exitoso) {
      const recuperable = estado === 429 || estado >= 500 || /capacity/i.test(crudo);
      const error = new ModeloNoDisponible(`El servicio respondió ${respuesta.status}.`);
      error.reintentable = recuperable;
      throw error;
    }

    let datos;
    try {
      datos = JSON.parse(crudo);
    } catch {
      throw new ModeloNoDisponible('El servicio devolvió una respuesta ilegible.');
    }
    if (!datos || typeof datos !== 'object') {
      throw new ModeloNoDisponible('El servicio devolvió una respuesta ilegible.');
    }
    return datos;
  }

  async function completar({ sistema, herramientas, mensajes } = {}) {
    const cuerpo = {
      model: modelo,
      max_tokens: maxTokensSalida,
      messages: [{ role: 'system', content: String(sistema == null ? '' : sistema) }, ...mensajesDe(mensajes)],
      tools: herramientasDe(herramientas),
      tool_choice: 'auto',
    };

    let datos;
    let intento = 0;
    for (;;) {
      intento += 1;
      try {
        datos = await enviar(cuerpo);
        break;
      } catch (error) {
        const reintentar = error instanceof ModeloNoDisponible
          && error.reintentable === true
          && intento === 1;
        if (!reintentar) throw error;
        await dormir(ESPERA_REINTENTO_MS);
      }
    }

    const eleccion = Array.isArray(datos.choices) ? datos.choices[0] : null;
    const mensaje = (eleccion && eleccion.message) || {};
    const llamadas = llamadasDe(mensaje);
    const finCrudo = (eleccion && eleccion.finish_reason) || null;
    const razonamiento = mensaje.reasoning_content;

    return {
      texto: textoDe(mensaje.content).trim(),
      llamadas,
      fin: finDeOpenAI(finCrudo, llamadas),
      fin_crudo: finCrudo,
      uso: usoDe(datos.usage),
      extra: typeof razonamiento === 'string' && razonamiento ? { reasoning_content: razonamiento } : null,
      crudo: datos,
    };
  }

  return { nombre: 'openai', modelo, completar };
}

module.exports = {
  crearModelo,
  herramientasDe,
  mensajesDe,
  llamadasDe,
  usoDe,
  finDeOpenAI,
  MAX_TOKENS_SALIDA,
  TIMEOUT_MS,
  ESPERA_REINTENTO_MS,
};
