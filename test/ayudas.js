'use strict';

/** Ayudas compartidas por las pruebas (no es un archivo de prueba). */

const { crearServidor } = require('../src/server.js');
const { cargarConfig } = require('../src/config.js');

/** Respuesta con la forma neutral que devuelve cualquier cliente de modelo. */
function respuesta({ texto = '', herramienta = null, fin = null, id = null, uso } = {}) {
  const llamadas = [];
  if (herramienta) {
    llamadas.push({
      id: id || herramienta.id || `call_${Math.random().toString(36).slice(2, 8)}`,
      nombre: herramienta.name,
      entrada: herramienta.input,
    });
  }
  const final = fin || (llamadas.length ? 'herramientas' : 'fin');
  return {
    texto,
    llamadas,
    fin: final,
    fin_crudo: final,
    uso: uso || { entrada: 1000, salida: 100, cache_w: 0, cache_r: 0 },
    extra: null,
    crudo: null,
  };
}

/**
 * Cliente falso por guion: cada llamada consume la siguiente respuesta.
 * `capturas` guarda los parámetros de cada pedido.
 */
function clienteGuion(respuestas, { error = null } = {}) {
  const capturas = [];
  let i = 0;
  return {
    capturas,
    nombre: 'guion',
    modelo: 'guion',
    completar: async (parametros) => {
      capturas.push(parametros);
      if (error) throw error;
      const r = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return typeof r === 'function' ? r(parametros) : r;
    },
  };
}

/** Cliente que siempre pide la misma herramienta (para el tope de llamadas). */
function clienteInfinito(nombre, input) {
  const capturas = [];
  return {
    capturas,
    nombre: 'infinito',
    modelo: 'infinito',
    completar: async (parametros) => {
      capturas.push(parametros);
      return respuesta({ herramienta: { name: nombre, input } });
    },
  };
}

async function servidorDePrueba(opciones = {}) {
  const config = cargarConfig({
    RECEPCIONISTA_MODELO: 'simulado',
    RECEPCIONISTA_DATOS: opciones.datos,
    RECEPCIONISTA_ORIGENES: opciones.origenes || 'http://127.0.0.1:8773',
    RECEPCIONISTA_POR_MINUTO: opciones.porMinuto || '8',
    RECEPCIONISTA_POR_DIA: opciones.porDia || '60',
    RECEPCIONISTA_TOPE_USD_MES: opciones.tope || '0.50',
    RECEPCIONISTA_CONCURRENCIA: opciones.concurrencia || '4',
    ...(opciones.entorno || {}),
  });
  const servidor = crearServidor({
    config,
    ahora: opciones.ahora,
    cliente: opciones.cliente,
  });
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address();
  return {
    servidor,
    config,
    base: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise((resolver) => servidor.close(resolver)),
  };
}

module.exports = { respuesta, clienteGuion, clienteInfinito, servidorDePrueba };
