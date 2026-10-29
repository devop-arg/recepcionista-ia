'use strict';

/**
 * Errores tipados de la capa de modelo y su clasificación para el registro.
 *
 * Nunca guardan el cuerpo de la respuesta, las cabeceras ni la clave: solo un
 * estado HTTP o un motivo corto, que es lo único que llega al log.
 */

/** La credencial fue rechazada (401/403). Va a respaldo y se registra como `auth`. */
class ModeloAuth extends Error {
  constructor() {
    super('El servicio del modelo rechazó la credencial.');
    this.name = 'ModeloAuth';
    this.clasificacion = 'auth';
  }
}

/**
 * El servicio no está disponible (429, 5xx, "capacity", red, timeout o una
 * respuesta ilegible). Va a respaldo.
 */
class ModeloNoDisponible extends Error {
  constructor(motivo = 'El servicio del modelo no está disponible.') {
    super(motivo);
    this.name = 'ModeloNoDisponible';
    this.clasificacion = 'no_disponible';
  }
}

/**
 * Nombre corto del error para el registro. Los errores tipados de esta capa
 * traen `clasificacion`; cualquier otro se identifica por su clase (nunca se
 * copia el mensaje, que puede traer detalles del servicio).
 */
function clasificarError(error) {
  if (!error) return 'Error';
  if (typeof error.clasificacion === 'string' && error.clasificacion) return error.clasificacion;
  return (error.constructor && error.constructor.name) || 'Error';
}

module.exports = { ModeloAuth, ModeloNoDisponible, clasificarError };
