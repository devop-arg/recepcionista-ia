'use strict';

/**
 * Precios en USD por millón de tokens y cálculo de costo por respuesta.
 *
 * Los precios salen de la configuración (`RECEPCIONISTA_PRECIO_ENTRADA` /
 * `_SALIDA`, 0.05 y 0.50 por defecto) y se aplican a cualquier modelo. El tope
 * mensual en dólares y el tope diario de tokens son los que acotan el gasto.
 */

const PRECIOS_POR_DEFECTO = Object.freeze({
  entrada: 0.05,
  salida: 0.5,
  cache_w: 0,
  cache_r: 0,
});

function token(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Devuelve los tokens normalizados de un `usage` o de un acumulado (pueden faltar todos). */
function tokensDe(usage) {
  const u = usage || {};
  return {
    entrada: token(u.input_tokens ?? u.entrada ?? u.prompt_tokens),
    salida: token(u.output_tokens ?? u.salida ?? u.completion_tokens),
    cache_w: token(u.cache_creation_input_tokens ?? u.cache_w),
    cache_r: token(u.cache_read_input_tokens ?? u.cache_r),
  };
}

/** Tokens totales de un acumulado: es lo que compara el tope diario de tokens. */
function tokensTotales(uso) {
  const t = tokensDe(uso);
  return t.entrada + t.salida + t.cache_w + t.cache_r;
}

/** Precios vigentes: los configurados completos o los de referencia. */
function precioDe(porDefecto) {
  return { ...PRECIOS_POR_DEFECTO, ...(porDefecto || {}) };
}

/** Costo en USD de una respuesta. Redondeado a 6 decimales (fracciones de centavo). */
function costoDe(usage, porDefecto) {
  const t = tokensDe(usage);
  const p = precioDe(porDefecto);
  const usd = (t.entrada * p.entrada
    + t.salida * p.salida
    + t.cache_w * p.cache_w
    + t.cache_r * p.cache_r) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** Suma dos `usage` parciales. */
function sumarUso(a, b) {
  const x = tokensDe(a);
  const y = tokensDe(b);
  return {
    entrada: x.entrada + y.entrada,
    salida: x.salida + y.salida,
    cache_w: x.cache_w + y.cache_w,
    cache_r: x.cache_r + y.cache_r,
  };
}

module.exports = {
  PRECIOS_POR_DEFECTO,
  precioDe,
  tokensDe,
  tokensTotales,
  costoDe,
  sumarUso,
};
