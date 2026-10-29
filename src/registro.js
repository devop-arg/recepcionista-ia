'use strict';

/**
 * Registro operativo: una línea JSON por pedido en
 * `data/registro-YYYY-MM-DD.jsonl`.
 *
 * Guarda métricas, nunca contenido: ni el texto de los mensajes, ni la agenda,
 * ni la IP en claro (solo un hash con sal).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fechaLocal } = require('./guardas.js');

function hashIp(ip, sal) {
  return crypto
    .createHash('sha256')
    .update(`${sal}|${String(ip || '')}`)
    .digest('hex')
    .slice(0, 12);
}

function crearRegistro({ dir, sal, ahora = () => new Date() } = {}) {
  function escribir(entrada = {}) {
    const fecha = fechaLocal(ahora());
    const línea = {
      ts: new Date(ahora()).toISOString(),
      ip_hash: entrada.ipHash || null,
      modelo: entrada.modelo || null,
      modo: entrada.modo || null,
      ms: Number.isFinite(entrada.ms) ? entrada.ms : null,
      llamadas: Number.isFinite(entrada.llamadas) ? entrada.llamadas : 0,
      herramientas: Array.isArray(entrada.herramientas) ? entrada.herramientas : [],
      tokens: {
        entrada: 0,
        salida: 0,
        cache_w: 0,
        cache_r: 0,
        ...(entrada.tokens || {}),
      },
      usd: Number.isFinite(entrada.usd) ? entrada.usd : 0,
      stop_reason: entrada.stopReason || null,
      error: entrada.error || null,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `registro-${fecha}.jsonl`), `${JSON.stringify(línea)}\n`);
    } catch {
      /* si el disco falla, el pedido igual se responde */
    }
    return línea;
  }

  return { escribir, hashIp: (ip) => hashIp(ip, sal) };
}

module.exports = { crearRegistro, hashIp };
