/* ============================================================
   Regina Salud — datos y lógica compartida
   Funciones puras (no tocan el DOM): agenda, ocupación, pacientes
   inventados deterministas, plantillas de WhatsApp, persistencia.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- datos ---------------- */

  var DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var DIAS_LARGOS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  var FERIADOS_2026 = [
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-03-24', '2026-04-02', '2026-04-03',
    '2026-05-01', '2026-05-25', '2026-06-15', '2026-06-20', '2026-07-09', '2026-08-17',
    '2026-10-12', '2026-11-23', '2026-12-08', '2026-12-25'
  ];

  var OBRAS_SOCIALES = ['PAMI', 'IOSFA', 'OSDE', 'Swiss Medical', 'Galeno', 'IPROSS', 'OSECAC', 'Particular'];

  var ESPECIALIDADES = [
    {
      id: 'clinica', nombre: 'Clínica médica', img: 'clinica.webp', alt: 'Médico de guardapolvo con estetoscopio', dur: 20,
      desc: 'Control general, certificados y seguimiento de tratamientos.',
      profesionales: [
        { id: 'ferreyra', nombre: 'Dra. Marta Ferreyra', mp: 'MP 3412', dias: [1, 2, 3, 4, 5] },
        { id: 'lombardo', nombre: 'Dr. Julián Lombardo', mp: 'MP 5127', dias: [1, 3, 5] }
      ]
    },
    {
      id: 'pediatria', nombre: 'Pediatría', img: 'pediatria.webp', alt: 'Foto de la especialidad de pediatría', dur: 20,
      desc: 'Controles de niño sano, vacunas y consultas por fiebre.',
      profesionales: [
        { id: 'benitez', nombre: 'Dra. Lucía Benítez', mp: 'MP 5521', dias: [1, 3, 5, 6] },
        { id: 'kruk', nombre: 'Dr. Andrés Kruk', mp: 'MP 6043', dias: [2, 4] }
      ]
    },
    {
      id: 'cardiologia', nombre: 'Cardiología', img: 'cardiologia.webp', alt: 'Foto de la especialidad de cardiología', dur: 20,
      desc: 'Electrocardiograma, control de presión y riesgo cardiovascular.',
      profesionales: [
        { id: 'sosa', nombre: 'Dr. Ricardo Sosa', mp: 'MP 2210', dias: [2, 4] }
      ]
    },
    {
      id: 'dermatologia', nombre: 'Dermatología', img: 'dermatologia.webp', alt: 'Foto de la especialidad de dermatología', dur: 15,
      desc: 'Control de lunares, acné, dermatitis y cuero cabelludo.',
      profesionales: [
        { id: 'gimenez', nombre: 'Dra. Paula Giménez', mp: 'MP 6634', dias: [1, 4] }
      ]
    },
    {
      id: 'ginecologia', nombre: 'Ginecología', img: 'ginecologia.webp', alt: 'Foto de la especialidad de ginecología', dur: 20,
      desc: 'Control anual, Papanicolau y seguimiento de embarazo.',
      profesionales: [
        { id: 'rios', nombre: 'Dra. Silvina Ríos', mp: 'MP 7788', dias: [2, 5] }
      ]
    },
    {
      id: 'traumatologia', nombre: 'Traumatología', img: 'traumatologia.webp', alt: 'Foto de la especialidad de traumatología', dur: 20,
      desc: 'Lesiones deportivas, dolores de espalda y control post quirúrgico.',
      profesionales: [
        { id: 'quiroga', nombre: 'Dr. Matías Quiroga', mp: 'MP 8890', dias: [1, 3, 5] }
      ]
    },
    {
      id: 'oftalmologia', nombre: 'Oftalmología', img: 'oftalmologia.webp', alt: 'Foto de la especialidad de oftalmología', dur: 15,
      desc: 'Control de vista, receta de anteojos y fondo de ojo.',
      profesionales: [
        { id: 'paz', nombre: 'Dr. Hernán Paz', mp: 'MP 4409', dias: [3, 6] }
      ]
    }
  ];

  /* ---------------- constantes propias de la demo ---------------- */

  var CLAVE_TURNOS = 'rs_turnos';
  var CLAVE_GESTION = 'rs_gestion';
  var CLAVE_CONFIG = 'rs_config';
  var CLAVE_BANDEJA = 'rs_bandeja';
  var DIAS_VISTA = 21;

  var ESTADOS = [
    { id: 'pendiente', label: 'Pendiente' },
    { id: 'confirmado', label: 'Confirmado' },
    { id: 'presente', label: 'En sala' },
    { id: 'atendido', label: 'Atendido' },
    { id: 'ausente', label: 'Ausente' }
  ];

  var ORIGENES = [
    { id: 'web', label: 'Web' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'telefono', label: 'Teléfono' },
    { id: 'recepcion', label: 'Recepción' }
  ];

  var VARIABLES = ['nombre', 'especialidad', 'profesional', 'fecha', 'hora', 'codigo'];

  var PLANTILLAS_DEFAULT = {
    confirmacion: 'Hola {nombre}, confirmamos tu turno de {especialidad} con {profesional} el {fecha} a las {hora} en Regina Salud. Código {codigo}. Si no podés venir, avisanos por acá.',
    recordatorio: 'Hola {nombre}, te recordamos tu turno de {especialidad} con {profesional} el {fecha} a las {hora} en Regina Salud. Respondé SÍ para confirmar o NO para cancelar. Código {codigo}.',
    cancelacion: 'Hola {nombre}, cancelamos tu turno de {especialidad} del {fecha} a las {hora}. Si querés reprogramarlo, respondé este mensaje y te damos otro horario.',
    respuesta: 'Hola {nombre}, recibimos tu mensaje. En breve te responde la recepción de Regina Salud.'
  };

  // Pacientes inventados: deterministas por profesional + día + hora.
  var NOMBRES = [
    'Marta', 'Jorge', 'Silvia', 'Carlos', 'Ana', 'Luis', 'Graciela', 'Roberto', 'Susana', 'Miguel',
    'Norma', 'Alberto', 'Claudia', 'Héctor', 'Patricia', 'Sergio', 'Mónica', 'Daniel', 'Gabriela',
    'Rubén', 'Alejandra', 'Oscar', 'Verónica', 'Raúl', 'Marcela', 'Eduardo', 'Lorena', 'Fernando',
    'Cristina', 'Pablo', 'Silvana', 'Marcelo', 'Andrea', 'Gustavo', 'Sandra', 'Diego'
  ];

  var NOMBRES_CHICOS = [
    'Mateo', 'Sofía', 'Thiago', 'Emma', 'Bautista', 'Valentina', 'Lorenzo', 'Catalina', 'Benicio',
    'Martina', 'Joaquín', 'Mía', 'Felipe', 'Delfina', 'Tomás', 'Julieta', 'Santino', 'Renata',
    'Ignacio', 'Guadalupe', 'Máximo', 'Isabella', 'Franco', 'Emilia', 'Bruno', 'Zoe', 'Lautaro',
    'Abril', 'Simón', 'Pilar'
  ];

  var APELLIDOS = [
    'Gómez', 'Pérez', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Díaz', 'Sánchez', 'Romero',
    'Sosa', 'Álvarez', 'Torres', 'Ruiz', 'Ramírez', 'Flores', 'Acosta', 'Benítez', 'Medina',
    'Herrera', 'Aguirre', 'Giménez', 'Molina', 'Silva', 'Castro', 'Rojas', 'Ortiz', 'Núñez',
    'Luna', 'Juárez', 'Cabrera', 'Ríos', 'Morales', 'Godoy', 'Vega', 'Pereyra', 'Ferreyra'
  ];

  /* ---------------- utilidades de fecha ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function isoDe(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function fechaDeIso(iso) {
    var p = String(iso).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function sumarDias(d, n) {
    var c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    c.setDate(c.getDate() + n);
    return c;
  }

  function horaAMinutos(h) {
    var p = String(h).split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function minutosAHora(m) {
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  function horaDeIso(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------------- grilla de atención ---------------- */

  // Lunes a viernes: 8-12 y 14-20. Sábado: 8-13. Domingo cerrado.
  function bloquesDelDia(iso) {
    var dow = fechaDeIso(iso).getDay();
    if (dow === 0) return [];
    if (dow === 6) return [[480, 780]];
    return [[480, 720], [840, 1200]];
  }

  function generarHorarios(iso, dur) {
    var res = [], bloques = bloquesDelDia(iso);
    for (var i = 0; i < bloques.length; i++) {
      for (var m = bloques[i][0]; m + dur <= bloques[i][1]; m += dur) {
        res.push(minutosAHora(m));
      }
    }
    return res;
  }

  function esFeriado(iso) { return FERIADOS_2026.indexOf(iso) !== -1; }

  function atiende(prof, iso) {
    var dow = fechaDeIso(iso).getDay();
    return dow !== 0 && !esFeriado(iso) && prof.dias.indexOf(dow) !== -1;
  }

  function profesionalPorId(profId) {
    for (var i = 0; i < ESPECIALIDADES.length; i++) {
      var e = ESPECIALIDADES[i];
      for (var j = 0; j < e.profesionales.length; j++) {
        if (e.profesionales[j].id === profId) return { esp: e, prof: e.profesionales[j] };
      }
    }
    return null;
  }

  function profesionalesDelDia(iso) {
    var res = [];
    ESPECIALIDADES.forEach(function (e) {
      e.profesionales.forEach(function (p) {
        if (atiende(p, iso)) res.push({ esp: e, prof: p });
      });
    });
    return res;
  }

  function diaHabil(iso) {
    if (fechaDeIso(iso).getDay() === 0) return false;
    if (esFeriado(iso)) return false;
    return profesionalesDelDia(iso).length > 0;
  }

  function proximoDiaHabil(ahora) {
    var base = ahora || new Date();
    var d = sumarDias(base, 1);
    for (var i = 0; i < 90; i++) {
      var iso = isoDe(d);
      if (diaHabil(iso)) return iso;
      d = sumarDias(d, 1);
    }
    return isoDe(sumarDias(base, 1));
  }

  function capacidadDia(iso, profId) {
    var total = 0;
    ESPECIALIDADES.forEach(function (e) {
      e.profesionales.forEach(function (p) {
        if (profId && p.id !== profId) return;
        if (!atiende(p, iso)) return;
        total += generarHorarios(iso, e.dur).length;
      });
    });
    return total;
  }

  /* ---------------- ocupación determinista ---------------- */

  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Ocupación fija por profesional + fecha + hora (no cambia al recargar).
  function pseudoOcupado(profId, iso, hora) {
    return hash32(profId + '|' + iso + '|' + hora) % 100 < 35;
  }

  // Cambios que hizo recepción sobre un turno inventado.
  function claveDe(profId, iso, hora) { return profId + '|' + iso + '|' + hora; }

  function esPasado(iso, hora, ahora) {
    var d = fechaDeIso(iso);
    var p = String(hora).split(':');
    var inicio = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(p[0]), Number(p[1]));
    return inicio.getTime() <= ahora.getTime();
  }

  /* ---------------- pacientes inventados ---------------- */

  function estadoBaseInventado(profId, iso, hora, ahora) {
    var h = hash32(profId + '|' + iso + '|' + hora + '|estado');
    var base = ahora || new Date();
    if (esPasado(iso, hora, base)) return (h % 100 < 12) ? 'ausente' : 'atendido';
    if (iso === isoDe(base)) return (h % 100 < 65) ? 'confirmado' : 'pendiente';
    if (iso === isoDe(sumarDias(base, 1)) && h % 100 < 50) return 'confirmado';
    return 'pendiente';
  }

  function pacienteInventado(profId, iso, hora, ahora) {
    var clave = profId + '|' + iso + '|' + hora;
    var h = hash32(clave);
    var info = profesionalPorId(profId);
    var pediatria = !!(info && info.esp.id === 'pediatria');
    var nombres = pediatria ? NOMBRES_CHICOS : NOMBRES;
    var nombre = nombres[h % nombres.length] + ' ' + APELLIDOS[Math.floor(h / 7) % APELLIDOS.length];
    var obra = OBRAS_SOCIALES[Math.floor(h / 13) % OBRAS_SOCIALES.length];
    var origen = ORIGENES[Math.floor(h / 17) % ORIGENES.length].id;
    return {
      nombre: nombre,
      obra: obra,
      origen: origen,
      estadoBase: estadoBaseInventado(profId, iso, hora, ahora)
    };
  }

  /* ---------------- agenda del día (inventados + locales) ---------------- */

  function buscarTurno(turnos, profId, iso, hora) {
    for (var i = 0; i < (turnos || []).length; i++) {
      var t = turnos[i];
      if (t && t.profId === profId && t.fecha === iso && t.hora === hora) return t;
    }
    return null;
  }

  function estadoSlot(prof, iso, hora, turnos, ahora, gestion) {
    var clave = claveDe(prof.id, iso, hora);
    var g = (gestion || {})[clave];
    var t = buscarTurno(turnos || [], prof.id, iso, hora);
    if (t) {
      // Solo los turnos sacados por la web son "del visitante"; los que cargó
      // recepción (o llegaron por WhatsApp o teléfono) ocupan el horario.
      if ((t.origen || 'web') === 'web') return { estado: 'tuyo', turno: t };
      return { estado: 'ocupado', turno: t };
    }
    if (g && g.cancelado) return { estado: 'libre' };
    if (esPasado(iso, hora, ahora)) return { estado: 'pasado' };
    if (pseudoOcupado(prof.id, iso, hora)) return { estado: 'ocupado' };
    return { estado: 'libre' };
  }

  function disponible(prof, iso, hora, turnos, ahora, gestion) {
    return estadoSlot(prof, iso, hora, turnos, ahora, gestion).estado === 'libre';
  }

  function estadoDia(prof, dur, iso, turnos, ahora, gestion) {
    var dow = fechaDeIso(iso).getDay();
    if (dow === 0) return { estado: 'cerrado', motivo: 'Domingo', libres: 0, total: 0 };
    if (esFeriado(iso)) return { estado: 'feriado', motivo: 'Feriado', libres: 0, total: 0 };
    if (prof.dias.indexOf(dow) === -1) return { estado: 'noatiende', motivo: 'No atiende', libres: 0, total: 0 };
    var horas = generarHorarios(iso, dur), libres = 0;
    for (var i = 0; i < horas.length; i++) {
      if (disponible(prof, iso, horas[i], turnos, ahora, gestion)) libres++;
    }
    if (!libres) return { estado: 'lleno', motivo: 'Sin turnos', libres: 0, total: horas.length };
    return { estado: 'libre', motivo: libres === 1 ? '1 libre' : libres + ' libres', libres: libres, total: horas.length };
  }

  function primerTurnoDeEspecialidad(esp, turnos, ahora, gestion) {
    for (var i = 0; i < DIAS_VISTA; i++) {
      var iso = isoDe(sumarDias(ahora, i));
      var horas = null;
      for (var j = 0; j < esp.profesionales.length; j++) {
        var prof = esp.profesionales[j];
        if (!atiende(prof, iso)) continue;
        if (!horas) horas = generarHorarios(iso, esp.dur);
        for (var k = 0; k < horas.length; k++) {
          if (disponible(prof, iso, horas[k], turnos, ahora, gestion)) {
            return { esp: esp, prof: prof, fecha: iso, hora: horas[k] };
          }
        }
      }
    }
    return null;
  }

  function proximosDisponibles(turnos, cantidad, ahora, gestion) {
    var res = [];
    for (var i = 0; i < ESPECIALIDADES.length; i++) {
      var t = primerTurnoDeEspecialidad(ESPECIALIDADES[i], turnos, ahora, gestion);
      if (t) res.push(t);
    }
    res.sort(function (a, b) {
      var fa = a.fecha + a.hora, fb = b.fecha + b.hora;
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    });
    return res.slice(0, cantidad);
  }

  function turnosDelDia(iso, ahora, turnosLocales, gestion) {
    var base = ahora || new Date();
    var locales = turnosLocales || [];
    var gest = gestion || {};
    var res = [];
    var capacidad = 0;
    var ocupadosGrilla = 0;

    ESPECIALIDADES.forEach(function (esp) {
      esp.profesionales.forEach(function (prof) {
        if (!atiende(prof, iso)) return;
        var horas = generarHorarios(iso, esp.dur);
        capacidad += horas.length;
        horas.forEach(function (hora) {
          var clave = claveDe(prof.id, iso, hora);
          var g = gest[clave] || {};
          var local = buscarTurno(locales, prof.id, iso, hora);
          // Un turno cargado gana sobre una cancelación anterior del mismo hueco.
          if (!local && g.cancelado) return;
          var item = {
            clave: clave, fecha: iso, profId: prof.id, espId: esp.id, hora: hora,
            espNombre: esp.nombre, profNombre: prof.nombre, profMp: prof.mp,
            dur: (local && local.dur) || esp.dur,
            local: !!local,
            paciente: local ? local.paciente : '',
            obra: local ? local.obra : '',
            origen: local ? (local.origen || 'web') : 'web',
            estado: 'pendiente',
            celular: local ? (local.celular || '') : '',
            codigo: local ? (local.codigo || '') : '',
            llegada: null,
            recordatorio: null,
            notas: ''
          };
          if (local) {
            item.estado = g.estado || local.estado || 'pendiente';
            item.llegada = local.llegada || g.llegada || null;
            item.recordatorio = local.recordatorio || g.recordatorio || null;
            item.notas = g.notas != null ? g.notas : (local.notas || '');
          } else {
            if (!pseudoOcupado(prof.id, iso, hora)) return;
            var inv = pacienteInventado(prof.id, iso, hora, base);
            item.paciente = inv.nombre;
            item.obra = inv.obra;
            item.origen = inv.origen;
            item.estado = g.estado || inv.estadoBase;
            item.llegada = g.llegada || null;
            item.recordatorio = g.recordatorio || null;
            item.notas = g.notas || '';
          }
          ocupadosGrilla++;
          res.push(item);
        });
      });
    });

    // Turnos cargados a mano en horarios fuera de la grilla del profesional.
    locales.forEach(function (t) {
      if (!t || t.fecha !== iso) return;
      var clave = claveDe(t.profId, iso, t.hora);
      for (var i = 0; i < res.length; i++) if (res[i].clave === clave) return;
      var g = gest[clave] || {};
      var info = profesionalPorId(t.profId);
      res.push({
        clave: clave, fecha: iso, profId: t.profId, espId: t.espId || (info ? info.esp.id : ''),
        hora: t.hora,
        espNombre: t.espNombre || (info ? info.esp.nombre : ''),
        profNombre: t.profNombre || (info ? info.prof.nombre : ''),
        profMp: t.profMp || (info ? info.prof.mp : ''),
        dur: t.dur || (info ? info.esp.dur : 20),
        local: true, fueraDeGrilla: true, paciente: t.paciente, obra: t.obra,
        origen: t.origen || 'web',
        estado: g.estado || t.estado || 'pendiente',
        celular: t.celular || '', codigo: t.codigo || '',
        llegada: t.llegada || g.llegada || null,
        recordatorio: t.recordatorio || g.recordatorio || null,
        notas: g.notas != null ? g.notas : (t.notas || '')
      });
    });

    res.sort(function (a, b) {
      if (a.hora !== b.hora) return a.hora < b.hora ? -1 : 1;
      return a.profNombre < b.profNombre ? -1 : a.profNombre > b.profNombre ? 1 : 0;
    });
    res.capacidad = capacidad;
    res.libres = Math.max(0, capacidad - ocupadosGrilla);
    return res;
  }

  function resumenDia(lista) {
    var l = lista || [];
    var r = {
      total: l.length, pendientes: 0, confirmados: 0, presentes: 0,
      atendidos: 0, ausentes: 0, libres: 0, capacidad: 0, ocupacion: 0
    };
    l.forEach(function (t) {
      if (t.estado === 'pendiente') r.pendientes++;
      else if (t.estado === 'confirmado') r.confirmados++;
      else if (t.estado === 'presente') r.presentes++;
      else if (t.estado === 'atendido') r.atendidos++;
      else if (t.estado === 'ausente') r.ausentes++;
    });
    r.capacidad = l.capacidad != null ? l.capacidad : (l.libres != null ? l.length + l.libres : l.length);
    r.libres = l.libres != null ? l.libres : Math.max(0, r.capacidad - l.length);
    r.ocupacion = r.capacidad ? Math.round(r.total / r.capacidad * 100) : 0;
    return r;
  }

  /* ---------------- formato ---------------- */

  function formatearFechaLarga(iso, hora) {
    var d = fechaDeIso(iso);
    var txt = DIAS_LARGOS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()];
    return hora ? txt + ', ' + hora : txt;
  }

  function formatearFechaCorta(iso) {
    var d = fechaDeIso(iso);
    return DIAS_CORTOS[d.getDay()].toLowerCase() + ' ' + d.getDate() + ' ' + MESES_CORTOS[d.getMonth()];
  }

  function etiquetaDia(iso, ahora) {
    var hoy = isoDe(ahora || new Date());
    if (iso === hoy) return 'Hoy';
    if (iso === isoDe(sumarDias(ahora || new Date(), 1))) return 'Mañana';
    return formatearFechaCorta(iso);
  }

  function diasTexto(dias) {
    var nombres = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
    var orden = [1, 2, 3, 4, 5, 6];
    var lista = orden.filter(function (d) { return dias.indexOf(d) !== -1; });
    if (lista.length === 5 && dias.indexOf(6) === -1 && dias.indexOf(0) === -1) return 'Lun a vie';
    var txt = lista.map(function (d) { return nombres[d]; });
    if (txt.length === 1) return capitalizar(txt[0]);
    return capitalizar(txt.slice(0, -1).join(', ') + ' y ' + txt[txt.length - 1]);
  }

  function capitalizar(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function iniciales(nombre) {
    var limpio = String(nombre).replace(/^(Dra?\.|Lic\.)\s*/i, '').trim().split(/\s+/);
    var ini = (limpio[0] || '').charAt(0) + (limpio[1] ? limpio[1].charAt(0) : '');
    return ini.toUpperCase();
  }

  function primerNombre(nombre) {
    return String(nombre || '').trim().split(/\s+/)[0] || '';
  }

  function etiquetaEstado(estado) {
    for (var i = 0; i < ESTADOS.length; i++) if (ESTADOS[i].id === estado) return ESTADOS[i].label;
    return 'Pendiente';
  }

  function etiquetaOrigen(origen) {
    for (var i = 0; i < ORIGENES.length; i++) if (ORIGENES[i].id === origen) return ORIGENES[i].label;
    return 'Web';
  }

  /* ---------------- validación ---------------- */

  function validarPaciente(datos) {
    var e = {};
    var nombre = String(datos.nombre == null ? '' : datos.nombre).trim().replace(/\s+/g, ' ');
    var dni = String(datos.dni == null ? '' : datos.dni).trim().replace(/[.\s]/g, '');
    var celular = String(datos.celular == null ? '' : datos.celular).trim().replace(/[\s\-().]/g, '');
    var obra = String(datos.obra == null ? '' : datos.obra).trim();
    var afiliado = String(datos.afiliado == null ? '' : datos.afiliado).trim();

    if (nombre.length < 5 || nombre.indexOf(' ') === -1) e.nombre = 'Ingresá nombre y apellido.';
    if (!/^\d{7,8}$/.test(dni)) e.dni = 'El DNI tiene que tener 7 u 8 dígitos.';
    if (!/^\d{10}$/.test(celular)) e.celular = 'Ingresá 10 dígitos, sin 0 ni 15. Ejemplo: 2984123456.';
    if (OBRAS_SOCIALES.indexOf(obra) === -1) e.obra = 'Elegí una obra social o Particular.';
    if (obra !== 'Particular' && afiliado && afiliado.length < 3) e.afiliado = 'Revisá el número de afiliado.';

    return {
      ok: Object.keys(e).length === 0,
      errores: e,
      datos: { nombre: nombre, dni: dni, celular: celular, obra: obra, afiliado: afiliado, primera: !!datos.primera }
    };
  }

  /* ---------------- código de turno ---------------- */

  function generarCodigo(turnos) {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var usado = function (c) {
      return (turnos || []).some(function (t) { return t.codigo === c; });
    };
    var codigo;
    do {
      codigo = 'RS-';
      for (var i = 0; i < 4; i++) codigo += abc.charAt(Math.floor(Math.random() * abc.length));
    } while (usado(codigo));
    return codigo;
  }

  /* ---------------- calendario .ics ---------------- */

  function icsFecha(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + pad2(d.getMinutes()) + '00';
  }

  function escaparIcs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  function fechaHoraDe(iso, hora) {
    var d = fechaDeIso(iso), p = String(hora).split(':');
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(p[0]), Number(p[1]));
  }

  function generarICS(turno) {
    var ini = fechaHoraDe(turno.fecha, turno.hora);
    var fin = new Date(ini.getTime() + (turno.dur || 20) * 60000);
    var lineas = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Regina Salud//Turnos//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + turno.codigo + '@reginasalud',
      'DTSTAMP:' + icsFecha(new Date()),
      'DTSTART:' + icsFecha(ini),
      'DTEND:' + icsFecha(fin),
      'SUMMARY:' + escaparIcs('Turno de ' + turno.espNombre + ' — ' + turno.profNombre),
      'LOCATION:' + escaparIcs('Regina Salud, Villa Regina, Río Negro'),
      'DESCRIPTION:' + escaparIcs('Código ' + turno.codigo + '. Llegá 10 minutos antes con DNI y credencial de la obra social.'),
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    return lineas.join('\r\n') + '\r\n';
  }

  /* ---------------- WhatsApp ---------------- */

  function normalizarCelular(numero) {
    var n = String(numero == null ? '' : numero).replace(/\D/g, '');
    if (n.length === 13 && n.indexOf('549') === 0) n = n.slice(3);
    else if (n.length === 12 && n.indexOf('54') === 0) n = n.slice(2);
    else if (n.length === 11 && n.charAt(0) === '0') n = n.slice(1);
    return /^\d{10}$/.test(n) ? n : '';
  }

  function telefonoValido(numero) { return normalizarCelular(numero) !== ''; }

  function enlaceWhatsApp(numero, texto) {
    var t = encodeURIComponent(String(texto == null ? '' : texto));
    var n = normalizarCelular(numero);
    return n ? 'https://wa.me/549' + n + '?text=' + t : 'https://wa.me/?text=' + t;
  }

  function rellenarPlantilla(texto, datos) {
    var d = datos || {};
    return String(texto == null ? '' : texto).replace(/\{(nombre|especialidad|profesional|fecha|hora|codigo)\}/g, function (m, k) {
      return d[k] == null ? '' : String(d[k]);
    });
  }

  function plantillaMeta(texto) {
    var variables = [];
    var salida = String(texto == null ? '' : texto).replace(/\{(nombre|especialidad|profesional|fecha|hora|codigo)\}/g, function (m, k) {
      var i = variables.indexOf(k);
      if (i === -1) { variables.push(k); i = variables.length - 1; }
      return '{{' + (i + 1) + '}}';
    });
    return { texto: salida, variables: variables };
  }

  function datosPlantilla(t) {
    if (!t) return {};
    return {
      nombre: primerNombre(t.paciente),
      especialidad: t.espNombre || '',
      profesional: t.profNombre || '',
      fecha: t.fecha ? formatearFechaLarga(t.fecha) : '',
      hora: t.hora || '',
      codigo: t.codigo || '—'
    };
  }

  /* ---------------- persistencia ---------------- */

  function leer(clave, porDefecto) {
    try {
      if (typeof localStorage === 'undefined') return porDefecto;
      var raw = localStorage.getItem(clave);
      if (!raw) return porDefecto;
      var dato = JSON.parse(raw);
      return dato == null ? porDefecto : dato;
    } catch (e) { return porDefecto; }
  }

  function guardar(clave, valor) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(clave, JSON.stringify(valor));
    } catch (e) { /* sin storage */ }
  }

  function leerTurnos() {
    var arr = leer(CLAVE_TURNOS, []);
    return Array.isArray(arr) ? arr : [];
  }

  function guardarTurnos(lista) { guardar(CLAVE_TURNOS, lista || []); }

  function leerGestion() {
    var obj = leer(CLAVE_GESTION, {});
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  }

  function guardarGestion(obj) { guardar(CLAVE_GESTION, obj || {}); }

  function configDefault() {
    return {
      waCentro: '',
      plantillas: {
        confirmacion: PLANTILLAS_DEFAULT.confirmacion,
        recordatorio: PLANTILLAS_DEFAULT.recordatorio,
        cancelacion: PLANTILLAS_DEFAULT.cancelacion,
        respuesta: PLANTILLAS_DEFAULT.respuesta
      }
    };
  }

  function leerConfig() {
    var base = configDefault();
    var c = leer(CLAVE_CONFIG, null);
    if (!c || typeof c !== 'object') return base;
    var plantillas = base.plantillas;
    if (c.plantillas && typeof c.plantillas === 'object') {
      Object.keys(base.plantillas).forEach(function (k) {
        if (typeof c.plantillas[k] === 'string' && c.plantillas[k].trim()) plantillas[k] = c.plantillas[k];
      });
    }
    return { waCentro: normalizarCelular(c.waCentro || ''), plantillas: plantillas };
  }

  function guardarConfig(cfg) { guardar(CLAVE_CONFIG, cfg || configDefault()); }

  function leerBandeja() {
    var b = leer(CLAVE_BANDEJA, null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return { leidas: {}, respuestas: {}, acciones: {} };
    return {
      leidas: b.leidas && typeof b.leidas === 'object' ? b.leidas : {},
      respuestas: b.respuestas && typeof b.respuestas === 'object' ? b.respuestas : {},
      acciones: b.acciones && typeof b.acciones === 'object' ? b.acciones : {}
    };
  }

  function guardarBandeja(b) { guardar(CLAVE_BANDEJA, b || {}); }

  /* ---------------- bandeja de WhatsApp (datos fijos) ---------------- */

  var CONVERSACIONES = [
    {
      id: 'c1', nombre: 'Mariana Álvarez', hora: '09:12', noLeidos: 2,
      especialidad: 'pediatria', accion: 'asignar', accionTexto: 'Asignar turno',
      mensajes: [
        { de: 'paciente', hora: '09:12', texto: 'Hola, necesito un turno de pediatría para mi hijo de 4 años, ¿tienen para esta semana?' },
        { de: 'paciente', hora: '09:13', texto: 'Es la primera vez que lo traigo, tiene obra social OSDE.' }
      ]
    },
    {
      id: 'c2', nombre: 'Diego Ferreyra', hora: '08:47', noLeidos: 1,
      especialidad: null, accion: 'confirmar', accionTexto: 'Marcar confirmado',
      mensajes: [
        { de: 'paciente', hora: '08:47', texto: 'Buen día, confirmo el turno de mañana. Llego 10 minutos antes.' }
      ]
    },
    {
      id: 'c3', nombre: 'Ana Rojas', hora: '08:20', noLeidos: 0,
      especialidad: null, accion: 'cancelar', accionTexto: 'Cancelar turno',
      mensajes: [
        { de: 'paciente', hora: '08:20', texto: 'Hola, no voy a poder ir mañana. Me salió un viaje de trabajo, ¿lo cancelamos?' }
      ]
    },
    {
      id: 'c4', nombre: 'Silvia Medina', hora: 'Ayer', noLeidos: 0,
      especialidad: null, accion: 'respuesta', accionTexto: 'Responder con plantilla',
      mensajes: [
        { de: 'paciente', hora: 'Ayer', texto: '¿Trabajan con IPROSS? Quería saber si la consulta de cardiología está cubierta.' }
      ]
    },
    {
      id: 'c5', nombre: 'Raúl Benítez', hora: 'Ayer', noLeidos: 1,
      especialidad: null, accion: 'respuesta', accionTexto: 'Responder con plantilla',
      mensajes: [
        { de: 'paciente', hora: 'Ayer', texto: 'Necesito la receta de mi medicamento para presión. ¿La puede renovar la doctora?' }
      ]
    }
  ];

  /* ---------------- exportación ---------------- */

  var RS = {
    // datos
    DIAS_CORTOS: DIAS_CORTOS,
    DIAS_LARGOS: DIAS_LARGOS,
    MESES: MESES,
    MESES_CORTOS: MESES_CORTOS,
    FERIADOS_2026: FERIADOS_2026,
    OBRAS_SOCIALES: OBRAS_SOCIALES,
    ESPECIALIDADES: ESPECIALIDADES,
    especialidades: ESPECIALIDADES,
    obrasSociales: OBRAS_SOCIALES,
    feriados: FERIADOS_2026,
    ESTADOS: ESTADOS,
    estados: ESTADOS,
    ORIGENES: ORIGENES,
    origenes: ORIGENES,
    VARIABLES: VARIABLES,
    PLANTILLAS_DEFAULT: PLANTILLAS_DEFAULT,
    CONVERSACIONES: CONVERSACIONES,
    DIAS_VISTA: DIAS_VISTA,
    CLAVES: { turnos: CLAVE_TURNOS, gestion: CLAVE_GESTION, config: CLAVE_CONFIG, bandeja: CLAVE_BANDEJA },

    // fechas
    pad2: pad2,
    isoDe: isoDe,
    fechaDeIso: fechaDeIso,
    sumarDias: sumarDias,
    horaAMinutos: horaAMinutos,
    minutosAHora: minutosAHora,
    horaDeIso: horaDeIso,
    formatearFechaLarga: formatearFechaLarga,
    formatearFechaCorta: formatearFechaCorta,
    etiquetaDia: etiquetaDia,

    // agenda
    bloquesDelDia: bloquesDelDia,
    generarHorarios: generarHorarios,
    esFeriado: esFeriado,
    atiende: atiende,
    profesionalPorId: profesionalPorId,
    profesionalesDelDia: profesionalesDelDia,
    diaHabil: diaHabil,
    proximoDiaHabil: proximoDiaHabil,
    capacidadDia: capacidadDia,
    hash32: hash32,
    pseudoOcupado: pseudoOcupado,
    claveDe: claveDe,
    esPasado: esPasado,
    buscarTurno: buscarTurno,
    estadoSlot: estadoSlot,
    disponible: disponible,
    estadoDia: estadoDia,
    primerTurnoDeEspecialidad: primerTurnoDeEspecialidad,
    proximosDisponibles: proximosDisponibles,
    pacienteInventado: pacienteInventado,
    estadoBaseInventado: estadoBaseInventado,
    turnosDelDia: turnosDelDia,
    resumenDia: resumenDia,

    // texto
    diasTexto: diasTexto,
    capitalizar: capitalizar,
    iniciales: iniciales,
    primerNombre: primerNombre,
    etiquetaEstado: etiquetaEstado,
    etiquetaOrigen: etiquetaOrigen,

    // pacientes
    validarPaciente: validarPaciente,
    generarCodigo: generarCodigo,
    generarICS: generarICS,
    fechaHoraDe: fechaHoraDe,

    // whatsapp
    normalizarCelular: normalizarCelular,
    telefonoValido: telefonoValido,
    enlaceWhatsApp: enlaceWhatsApp,
    rellenarPlantilla: rellenarPlantilla,
    plantillaMeta: plantillaMeta,
    datosPlantilla: datosPlantilla,

    // persistencia
    leerTurnos: leerTurnos,
    guardarTurnos: guardarTurnos,
    leerGestion: leerGestion,
    guardarGestion: guardarGestion,
    leerConfig: leerConfig,
    guardarConfig: guardarConfig,
    configDefault: configDefault,
    leerBandeja: leerBandeja,
    guardarBandeja: guardarBandeja
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RS; else window.RS = RS;
})();
