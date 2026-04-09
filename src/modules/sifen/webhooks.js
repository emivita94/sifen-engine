// src/modules/sifen/webhooks.js
// Notificaciones de estado del DE al ERP del cliente
//
// Cada vez que un DE cambia de estado, NODO hace un POST
// a la webhookUrl que el ERP registró al emitir el documento.
//
// El payload es siempre el mismo objeto estandarizado,
// independientemente del estado — el ERP solo tiene que
// escuchar en un endpoint y actualizar su BD.

import { createHmac } from 'node:crypto'
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
 * @param {string|null} webhookSecret - Secret HMAC del tenant (si está configurado)
 */
export async function dispararWebhook(doc, evento, webhookSecret = null) {
  if (!doc.webhookUrl) return   // el ERP no registró URL → skip silencioso

  const payload = construirPayload(doc, evento)

  // Intento 1 inmediato (en background, no bloquea la respuesta al ERP)
  enviarConReintentos(doc.id, doc.webhookUrl, payload, 0, webhookSecret).catch(() => {})
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
 * Genera los headers de firma HMAC-SHA256 para el webhook.
 * El ERP puede verificar la autenticidad del webhook usando:
 *   expected = 'sha256=' + HMAC-SHA256(`${timestamp}.${body}`, secret)
 *
 * @param {string} body   - JSON stringificado del payload
 * @param {string} secret - Webhook secret del tenant
 * @returns {{ 'X-Webhook-Signature': string, 'X-Webhook-Timestamp': string }}
 */
function generarHeadersFirma(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const mensaje   = `${timestamp}.${body}`
  const firma     = createHmac('sha256', secret).update(mensaje).digest('hex')

  return {
    'X-Webhook-Signature': `sha256=${firma}`,
    'X-Webhook-Timestamp': timestamp,
  }
}

/**
 * Envía el webhook con reintentos y backoff exponencial.
 * Si todos los intentos fallan, registra en BD para revisión manual.
 */
async function enviarConReintentos(docId, url, payload, intento, webhookSecret = null) {
  const inicio = Date.now()
  const body   = JSON.stringify(payload)

  try {
    // Headers base
    const headers = {
      'Content-Type':    'application/json',
      'X-Nodo-Evento':   payload.evento,
      'X-Nodo-Entrega':  String(intento + 1),
    }

    // Si hay secret configurado, agregar firma HMAC-SHA256
    if (webhookSecret) {
      Object.assign(headers, generarHeadersFirma(body, webhookSecret))
    }

    const res = await fetch(url, {
      method:  'POST',
      headers,
      body,
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
        enviarConReintentos(docId, url, payload, intento + 1, webhookSecret).catch(() => {})
      }, delay)
    }

  } catch (err) {
    const duracionMs = Date.now() - inicio

    await registrarIntento(docId, payload.evento, url, intento + 1,
      payload, null, duracionMs, false, err.message)

    if (intento < REINTENTOS_MAX - 1) {
      const delay = DELAYS_MS[intento] ?? DELAYS_MS.at(-1)
      setTimeout(() => {
        enviarConReintentos(docId, url, payload, intento + 1, webhookSecret).catch(() => {})
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
