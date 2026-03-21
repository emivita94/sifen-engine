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
 * Mapa de códigos SIFEN a mensajes legibles en español
 * para mostrar en el panel o logear de forma útil
 */
export const CODIGOS_SIFEN = {
  '0260': 'Aprobado',
  '0422': 'Aprobado con observaciones',
  '0404': 'Rechazado - CDC duplicado',
  '0418': 'Rechazado - Timbrado inválido',
  '0419': 'Rechazado - Timbrado vencido',
  '0420': 'Rechazado - RUC emisor no encontrado',
  '0421': 'Rechazado - Error en firma digital',
  '0423': 'Rechazado - Error en estructura del XML',
  '0500': 'Error interno de SIFEN',
  'ERR':  'Error de conexión con SIFEN (timeout o red)',
}

export function descripcionCodigo(codigo) {
  return CODIGOS_SIFEN[codigo] ?? `Código desconocido: ${codigo}`
}
