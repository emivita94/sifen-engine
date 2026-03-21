// src/modules/sifen/webhooks.js
// Notificaciones de estado del DE al ERP del cliente
//
// Cada vez que un DE cambia de estado, NODO hace un POST
// a la webhookUrl que el ERP registró al emitir el documento.
//
// El payload es siempre el mismo objeto estandarizado,
// independientemente del estado — el ERP solo tiene que
// escuchar en un endpoint y actualizar su BD.

import { getDb } from '../../db/connection.js'

// ── Payload estándar que recibe el ERP ────────────────────────────────────────
//
// {
//   evento:     "de.aprobado" | "de.rechazado" | "de.cancelado" | "de.inutilizado"
//   timestamp:  "2024-01-15T14:32:00.000Z"
//   documento: {
//     id:               "uuid interno NODO",
//     cdc:              "44 dígitos",
//     numero:           "001-001-0000001",
//     tipoDocumento:    1,
//     estado:           "aprobado",
//     referenciaExterna:"ID del ERP que mandó al crear",   ← clave para que el ERP identifique su registro
//     receptor: {
//       documento:      "80000001-1",
//       razonSocial:    "Cliente S.A."
//     },
//     montoTotal:       1000000,
//     sifen: {
//       codigo:         "0260",
//       mensaje:        "Aprobado",
//       enviadoEn:      "2024-01-15T14:31:58.000Z",
//       respondidoEn:   "2024-01-15T14:32:00.000Z"
//     }
//   }
// }

const REINTENTOS_MAX = 5
// Backoff exponencial: 10s, 30s, 2m, 10m, 1h
const DELAYS_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000]

/**
 * Dispara el webhook para un documento.
 * Se llama siempre que el estado del DE cambia.
 * No bloquea — si falla, reintenta en background.
 *
 * @param {Object} doc  - Registro completo de la tabla documentos
 * @param {string} evento - "de.aprobado" | "de.rechazado" | "de.cancelado" | "de.inutilizado"
 */
export async function dispararWebhook(doc, evento) {
  if (!doc.webhookUrl) return   // el ERP no registró URL → skip silencioso

  const payload = construirPayload(doc, evento)

  // Intento 1 inmediato (en background, no bloquea la respuesta al ERP)
  enviarConReintentos(doc.id, doc.webhookUrl, payload, 0).catch(() => {})
}

/**
 * Construye el objeto estandarizado que recibe el ERP
 */
function construirPayload(doc, evento) {
  return {
    evento,
    timestamp: new Date().toISOString(),
    documento: {
      id:                doc.id,
      cdc:               doc.cdc,
      numero:            doc.numero,
      tipoDocumento:     doc.tipoDocumento,
      estado:            doc.estado,
      referenciaExterna: doc.referenciaExterna,   // ← el ID del ERP
      receptor: {
        tipo:        doc.receptorTipo,
        documento:   doc.receptorDoc,
        razonSocial: doc.receptorRazon,
      },
      montoTotal:    Number(doc.montoTotal),
      montoIVA10:    Number(doc.montoIva10 || 0),
      montoIVA5:     Number(doc.montoIva5  || 0),
      montoExento:   Number(doc.montoExento || 0),
      sifen: {
        codigo:       doc.sifenCodigo,
        mensaje:      doc.sifenMensaje,
        enviadoEn:    doc.sifenEnvEn,
        respondidoEn: doc.sifenRespEn,
      },
      creadoEn:      doc.creadoEn,
      actualizadoEn: doc.actualizadoEn,
    }
  }
}

/**
 * Envía el webhook con reintentos y backoff exponencial.
 * Si todos los intentos fallan, registra en BD para revisión manual.
 */
async function enviarConReintentos(docId, url, payload, intento) {
  const inicio = Date.now()

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Nodo-Evento':   payload.evento,
        'X-Nodo-Entrega':  String(intento + 1),
        // Firma HMAC opcional (para que el ERP verifique que viene de NODO)
        // 'X-Nodo-Firma': generarFirmaHMAC(payload),
      },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000),   // timeout 10s por intento
    })

    const duracionMs = Date.now() - inicio
    const exitoso = res.status >= 200 && res.status < 300

    // Registrar intento en BD
    await registrarIntento(docId, payload.evento, url, intento + 1,
      payload, res.status, duracionMs, exitoso)

    if (!exitoso && intento < REINTENTOS_MAX - 1) {
      // Programar próximo reintento
      const delay = DELAYS_MS[intento] ?? DELAYS_MS.at(-1)
      setTimeout(() => {
        enviarConReintentos(docId, url, payload, intento + 1).catch(() => {})
      }, delay)
    }

  } catch (err) {
    const duracionMs = Date.now() - inicio

    await registrarIntento(docId, payload.evento, url, intento + 1,
      payload, null, duracionMs, false, err.message)

    if (intento < REINTENTOS_MAX - 1) {
      const delay = DELAYS_MS[intento] ?? DELAYS_MS.at(-1)
      setTimeout(() => {
        enviarConReintentos(docId, url, payload, intento + 1).catch(() => {})
      }, delay)
    }
  }
}

/**
 * Guarda cada intento de webhook en la BD para auditoría y debugging
 */
async function registrarIntento(docId, evento, url, numeroIntento,
  payload, httpStatus, duracionMs, exitoso, errorMsg = null) {
  try {
    const sql = getDb()
    await sql`
      INSERT INTO webhook_logs (
        documento_id, evento, url, numero_intento,
        payload, http_status, duracion_ms, exitoso, error_msg
      ) VALUES (
        ${docId}, ${evento}, ${url}, ${numeroIntento},
        ${JSON.stringify(payload)}, ${httpStatus}, ${duracionMs},
        ${exitoso}, ${errorMsg}
      )
    `
  } catch {
    // No dejar que un fallo de log rompa el flujo principal
  }
}
