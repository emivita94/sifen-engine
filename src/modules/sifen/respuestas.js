// src/modules/sifen/respuestas.js
// Objeto de respuesta estandarizado que el motor retorna al ERP
// en CADA etapa del ciclo de vida del DE.
//
// El ERP siempre recibe el mismo shape — solo cambia el campo "estado"
// y los campos de sifen. Así el ERP puede hacer un switch simple.

/**
 * Construye la respuesta completa y consistente para el ERP.
 * Se usa tanto en la respuesta HTTP síncrona como en el payload del webhook.
 *
 * Estados posibles:
 *   pendiente   → se creó pero no se procesó aún (debería ser muy transitorio)
 *   firmado     → XML generado y firmado, esperando envío a SIFEN
 *   enviado     → enviado a SIFEN, esperando respuesta
 *   aprobado    → SIFEN devolvió código 0260 o 0422
 *   rechazado   → SIFEN devolvió error (ver sifen.codigo y sifen.mensaje)
 *   cancelado   → aprobado pero luego cancelado vía evento SIFEN
 *   inutilizado → numeración inutilizada
 *
 * Códigos SIFEN relevantes:
 *   0260 → Aprobado
 *   0422 → Aprobado con observaciones
 *   0422 → Rechazado (ver variantes)
 *   ERR  → Error de conexión (no llegó a SIFEN)
 */
export function respuestaDE(doc, extra = {}) {
  const aprobado = doc.estado === 'aprobado'
  const rechazado = doc.estado === 'rechazado'

  return {
    // ── Control de la respuesta ──────────────────────────────
    ok:      aprobado,
    estado:  doc.estado,          // la clave principal para el ERP

    // ── Identificadores del DE ───────────────────────────────
    id:               doc.id,
    cdc:              doc.cdc,         // null si fue rechazado antes de generar CDC
    numero:           doc.numero,      // "001-001-0000001"
    tipoDocumento:    doc.tipoDocumento,
    referenciaExterna: doc.referenciaExterna,   // ID del ERP, devuelto para correlacionar

    // ── Respuesta de SIFEN ───────────────────────────────────
    sifen: {
      codigo:  doc.sifenCodigo,    // "0260" aprobado, otro = rechazado
      mensaje: doc.sifenMensaje,   // texto exacto de la SET
      aprobado,
      rechazado,
    },

    // ── Montos ───────────────────────────────────────────────
    montos: {
      total:   Number(doc.montoTotal  || 0),
      iva10:   Number(doc.montoIva10  || 0),
      iva5:    Number(doc.montoIva5   || 0),
      exento:  Number(doc.montoExento || 0),
    },

    // ── Receptor ─────────────────────────────────────────────
    receptor: {
      documento:   doc.receptorDoc,
      razonSocial: doc.receptorRazon,
    },

    // ── Links útiles ─────────────────────────────────────────
    links: doc.cdc ? {
      xml:    `/api/v1/documentos/${doc.cdc}/xml`,
      kude:   `/api/v1/documentos/${doc.cdc}/kude`,
      estado: `/api/v1/documentos/${doc.cdc}`,
    } : null,

    // ── Timestamps ───────────────────────────────────────────
    timestamps: {
      creado:      doc.creadoEn,
      enviado:     doc.sifenEnvEn,
      respondido:  doc.sifenRespEn,
      actualizado: doc.actualizadoEn,
    },

    // ── Campos extra opcionales (ej: para errores de validación) ──
    ...extra,
  }
}

/**
 * Respuesta de error antes de llegar a SIFEN
 * (validación, certificado inválido, timbrado vencido, etc.)
 */
export function respuestaError(mensaje, detalles = null) {
  return {
    ok:      false,
    estado:  'error',
    sifen:   null,
    error: {
      mensaje,
      detalles,
    }
  }
}

/**
 * Mapa completo de códigos SIFEN a objetos descriptivos.
 *
 * Cada entrada contiene:
 *   - descripcion : texto legible en español
 *   - tipo        : 'exito' | 'rechazo' | 'error' | 'info'
 *   - sugerencia  : acción recomendada para el integrador (null si no aplica)
 *
 * Referencia: Manual Técnico SIFEN - SET Paraguay
 */
export const CODIGOS_SIFEN = {

  // ── Recepción de lote (03xx) ────────────────────────────────
  '0300': {
    descripcion: 'Lote recibido con éxito',
    tipo: 'exito',
    sugerencia: null,
  },
  '0301': {
    descripcion: 'Lote ya fue recibido anteriormente',
    tipo: 'info',
    sugerencia: 'El lote ya fue enviado. Consultar el resultado con el número de lote original en vez de reenviar.',
  },
  '0302': {
    descripcion: 'Tamaño del lote excede el máximo permitido',
    tipo: 'rechazo',
    sugerencia: 'Reducir la cantidad de documentos por lote. El máximo permitido por SIFEN es 50 DEs por lote.',
  },
  '0310': {
    descripcion: 'Error en formato del XML del lote',
    tipo: 'rechazo',
    sugerencia: 'Revisar que el XML del lote cumpla con el esquema XSD de SIFEN. Verificar encoding UTF-8 y estructura del wrapper.',
  },

  // ── Consulta de lote (036x) ─────────────────────────────────
  '0360': {
    descripcion: 'Consulta exitosa',
    tipo: 'exito',
    sugerencia: null,
  },
  '0361': {
    descripcion: 'Lote en procesamiento',
    tipo: 'info',
    sugerencia: 'El lote aún está siendo procesado por SIFEN. Reintentar la consulta en unos segundos.',
  },
  '0362': {
    descripcion: 'Lote no encontrado',
    tipo: 'rechazo',
    sugerencia: 'Verificar que el número de lote sea correcto. Puede que el lote nunca fue recibido por SIFEN.',
  },

  // ── Procesamiento del DE (04xx) ─────────────────────────────
  '0400': {
    descripcion: 'Aprobado',
    tipo: 'exito',
    sugerencia: null,
  },
  '0401': {
    descripcion: 'RUC del emisor no existe',
    tipo: 'rechazo',
    sugerencia: 'Verificar que el RUC del emisor esté correctamente registrado en la SET y en la configuración del tenant.',
  },
  '0402': {
    descripcion: 'RUC del emisor no está activo',
    tipo: 'rechazo',
    sugerencia: 'El contribuyente emisor tiene su RUC cancelado o suspendido. Contactar a la SET para regularizar la situación.',
  },
  '0403': {
    descripcion: 'Establecimiento no registrado',
    tipo: 'rechazo',
    sugerencia: 'Registrar el establecimiento en el Marangatú de la SET antes de emitir documentos desde ese código de establecimiento.',
  },
  '0404': {
    descripcion: 'CDC duplicado',
    tipo: 'rechazo',
    sugerencia: 'Ya existe un DE con ese CDC en SIFEN. Verificar la numeración para evitar duplicados. Consultar el CDC existente.',
  },
  '0405': {
    descripcion: 'Timbrado no existe',
    tipo: 'rechazo',
    sugerencia: 'El número de timbrado no está registrado en la SET. Verificar que el timbrado fue aprobado y el número es correcto.',
  },
  '0406': {
    descripcion: 'Timbrado no vigente / vencido',
    tipo: 'rechazo',
    sugerencia: 'El timbrado ya venció. Solicitar un nuevo timbrado en el Marangatú y actualizar la configuración del tenant.',
  },
  '0407': {
    descripcion: 'Punto de expedición no registrado',
    tipo: 'rechazo',
    sugerencia: 'Registrar el punto de expedición en el Marangatú de la SET asociado al establecimiento y timbrado correspondiente.',
  },
  '0408': {
    descripcion: 'Número de documento fuera de rango del timbrado',
    tipo: 'rechazo',
    sugerencia: 'El número de documento está fuera del rango autorizado por el timbrado. Verificar el rango inicial y final del timbrado.',
  },
  '0409': {
    descripcion: 'Tipo de documento no válido',
    tipo: 'rechazo',
    sugerencia: 'Verificar que el tipo de documento electrónico (1-7) sea válido y esté habilitado para el contribuyente.',
  },
  '0410': {
    descripcion: 'Fecha del documento fuera de vigencia del timbrado',
    tipo: 'rechazo',
    sugerencia: 'La fecha de emisión del DE está fuera del período de vigencia del timbrado. Verificar fechas de inicio y fin del timbrado.',
  },
  '0411': {
    descripcion: 'Error en datos del receptor',
    tipo: 'rechazo',
    sugerencia: 'Revisar los datos del receptor: documento de identidad, razón social y tipo de contribuyente deben ser correctos.',
  },
  '0412': {
    descripcion: 'RUC del receptor no existe',
    tipo: 'rechazo',
    sugerencia: 'El RUC del receptor no está registrado en la SET. Verificar el número de RUC con el cliente.',
  },
  '0413': {
    descripcion: 'Error en cálculo de impuestos',
    tipo: 'rechazo',
    sugerencia: 'Revisar los cálculos de IVA. Los montos de impuesto deben coincidir con las tasas aplicadas (10%, 5%, exento) sobre los subtotales.',
  },
  '0414': {
    descripcion: 'Error en el monto total',
    tipo: 'rechazo',
    sugerencia: 'El monto total no coincide con la suma de los ítems. Verificar que subtotales + impuestos = total.',
  },
  '0415': {
    descripcion: 'Error en condición de venta',
    tipo: 'rechazo',
    sugerencia: 'Revisar la condición de venta (contado/crédito) y que los datos de pago/cuotas sean consistentes.',
  },
  '0416': {
    descripcion: 'Error en ítems del documento',
    tipo: 'rechazo',
    sugerencia: 'Revisar los ítems: cantidad, precio unitario, código y descripción deben ser válidos. Al menos un ítem es requerido.',
  },
  '0417': {
    descripcion: 'Error en datos de transporte',
    tipo: 'rechazo',
    sugerencia: 'Revisar los datos de transporte: tipo, modalidad, datos del transportista y vehículo deben ser válidos cuando aplique.',
  },
  '0418': {
    descripcion: 'Timbrado inválido',
    tipo: 'rechazo',
    sugerencia: 'Verificar que el número de timbrado esté registrado correctamente en la configuración del tenant y en el Marangatú.',
  },
  '0419': {
    descripcion: 'Timbrado vencido',
    tipo: 'rechazo',
    sugerencia: 'El timbrado expiró. Solicitar uno nuevo en el Marangatú de la SET y actualizar la configuración del tenant.',
  },
  '0420': {
    descripcion: 'RUC emisor no encontrado en registros SET',
    tipo: 'rechazo',
    sugerencia: 'El RUC del emisor no se encuentra en los registros de la SET. Verificar que el contribuyente está habilitado para facturación electrónica.',
  },
  '0421': {
    descripcion: 'Error en firma digital',
    tipo: 'rechazo',
    sugerencia: 'La firma digital es inválida. Verificar que el certificado (.p12/.pfx) no esté vencido y que la contraseña sea correcta.',
  },
  '0422': {
    descripcion: 'Aprobado con observaciones',
    tipo: 'exito',
    sugerencia: 'El documento fue aprobado pero tiene observaciones. Revisar el mensaje de SIFEN para corregir en futuras emisiones.',
  },
  '0423': {
    descripcion: 'Error en estructura del XML',
    tipo: 'rechazo',
    sugerencia: 'El XML del DE no cumple con el esquema XSD de SIFEN. Revisar campos obligatorios y formato de datos.',
  },
  '0424': {
    descripcion: 'Error en datos del emisor',
    tipo: 'rechazo',
    sugerencia: 'Revisar los datos del emisor: RUC, razón social, dirección y actividad económica deben coincidir con lo registrado en la SET.',
  },
  '0425': {
    descripcion: 'Error en datos de la condición de la operación',
    tipo: 'rechazo',
    sugerencia: 'Revisar los datos de condición de operación: forma de pago, plazos y montos de cuotas deben ser consistentes.',
  },
  '0426': {
    descripcion: 'Moneda no válida',
    tipo: 'rechazo',
    sugerencia: 'Verificar que el código de moneda sea válido (PYG, USD, BRL, etc.) y que el tipo de cambio esté informado para monedas extranjeras.',
  },

  // ── Aprobación general (026x) ───────────────────────────────
  '0260': {
    descripcion: 'Aprobado',
    tipo: 'exito',
    sugerencia: null,
  },

  // ── Eventos: cancelación e inutilización (00xx / 05xx) ──────
  '0085': {
    descripcion: 'Evento aprobado',
    tipo: 'exito',
    sugerencia: null,
  },
  '0500': {
    descripcion: 'Error interno de SIFEN',
    tipo: 'error',
    sugerencia: 'Error del lado de SIFEN. Reintentar el envío en unos minutos. Si persiste, verificar el estado del servicio SIFEN.',
  },
  '0501': {
    descripcion: 'Evento rechazado',
    tipo: 'rechazo',
    sugerencia: 'El evento fue rechazado. Revisar el mensaje de SIFEN para identificar la causa específica del rechazo.',
  },
  '0502': {
    descripcion: 'CDC del documento no encontrado',
    tipo: 'rechazo',
    sugerencia: 'El CDC no existe en SIFEN. Verificar que el documento fue aprobado previamente antes de intentar el evento.',
  },
  '0503': {
    descripcion: 'Documento ya fue cancelado',
    tipo: 'info',
    sugerencia: 'El documento ya tiene un evento de cancelación aprobado. No es necesario volver a cancelar.',
  },
  '0504': {
    descripcion: 'Documento no se puede cancelar (estado inválido)',
    tipo: 'rechazo',
    sugerencia: 'El documento no está en un estado que permita cancelación. Solo documentos aprobados pueden cancelarse dentro del plazo permitido.',
  },

  // ── Errores de conexión (internos del motor) ────────────────
  'ERR': {
    descripcion: 'Error de conexión con SIFEN',
    tipo: 'error',
    sugerencia: 'No se pudo conectar con los servidores de SIFEN. Verificar la conectividad de red y reintentar.',
  },
  'ERR_CONSULTA': {
    descripcion: 'Error consultando lote',
    tipo: 'error',
    sugerencia: 'Falló la consulta del resultado del lote. Reintentar la consulta en unos segundos.',
  },
  'TIMEOUT': {
    descripcion: 'SIFEN no respondió a tiempo',
    tipo: 'error',
    sugerencia: 'SIFEN no respondió dentro del tiempo límite. El lote pudo haber sido recibido. Consultar el estado antes de reenviar.',
  },
}

/**
 * Retorna el objeto completo del código SIFEN, o un objeto por defecto
 * para códigos desconocidos.
 *
 * @param {string} codigo - Código SIFEN (ej: '0260', '0418', 'ERR')
 * @returns {{ descripcion: string, tipo: string, sugerencia: string|null }}
 */
export function descripcionCodigo(codigo) {
  return CODIGOS_SIFEN[codigo] ?? {
    descripcion: `Código desconocido: ${codigo}`,
    tipo: 'error',
    sugerencia: 'Código no mapeado. Consultar el Manual Técnico SIFEN de la SET para más información.',
  }
}
