// src/modules/sifen/email.js
// Envío de documentos electrónicos por correo
// Se dispara automáticamente cuando la SET aprueba un documento
//
// Flujo:
//   1. SET aprueba el DE
//   2. Motor genera el KUDE en PDF
//   3. Envía al receptor (email del cliente) con el PDF adjunto
//   4. Envía copia al emisor (email del establecimiento)

import nodemailer from 'nodemailer'
import { generarKude } from './kude.js'
import { getDb } from '../../db/connection.js'

// ── Configuración SMTP del tenant ─────────────────────────────────────────────

function crearTransporte(tenant) {
  // Aceptar tanto snake_case (desde BD directa) como camelCase (desde motor.js)
  const host     = tenant.smtpHost     || tenant.smtp_host
  const port     = tenant.smtpPort     || tenant.smtp_port     || 587
  const ssl      = tenant.smtpSsl      ?? tenant.smtp_ssl      ?? false
  const user     = tenant.smtpUser     || tenant.smtp_user
  const pass     = tenant.smtpPass     || tenant.smtp_pass
  const fromAddr = tenant.smtpFrom     || tenant.smtp_from     || tenant.email
  const fromName = tenant.smtpFromName || tenant.smtp_from_name

  if (!host) return null

  return nodemailer.createTransport({
    host,
    port:   Number(port),
    secure: ssl === true || ssl === 'true' || Number(port) === 465,
    auth:   (user && pass) ? { user, pass } : undefined,
    tls:    { rejectUnauthorized: false },
  })
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Envía el KUDE por email al receptor y copia al emisor.
 * No bloquea — si falla, registra el error en la BD.
 *
 * @param {Object} doc    - Registro completo de la tabla documentos
 * @param {Object} tenant - Datos del tenant (emisor)
 */
export async function enviarEmailDocumento(doc, tenant) {
  // Solo enviamos documentos aprobados
  if (doc.estado !== 'aprobado') return

  // Necesitamos al menos un destinatario
  const emailReceptor = doc.receptorEmail || doc.receptor_email || null
  const emailEmisor   = tenant.smtpFrom || tenant.smtp_from || tenant.email || null

  if (!emailReceptor && !emailEmisor) return

  const transporte = crearTransporte(tenant)
  if (!transporte) {
    console.warn('[EMAIL] Sin configuración SMTP — omitiendo envío de email')
    return
  }

  try {
    // Generar el PDF del KUDE
    const pdfBytes = await generarKude(doc, tenant, 'a4', null)
    if (!pdfBytes) {
      console.warn('[EMAIL] No se pudo generar el KUDE para enviar por email')
      return
    }

    const tipoLabel = {
      1: 'Factura electrónica',
      4: 'Autofactura',
      5: 'Nota de crédito',
      6: 'Nota de débito',
      7: 'Nota de remisión',
    }

    const tipoDoc   = tipoLabel[doc.tipo_documento] || 'Documento electrónico'
    const emisorNom = tenant.nombre_fantasia || tenant.nombreFantasia || tenant.razon_social || tenant.razonSocial || ''
    const emisorRuc = tenant.ruc || ''
    const numero    = doc.numero || doc.cdc?.slice(0, 15) || '—'
    const monto     = doc.monto_total ? `₲ ${Number(doc.monto_total).toLocaleString('es-PY')}` : ''
    const fecha     = doc.creado_en ? new Date(doc.creado_en).toLocaleDateString('es-PY') : new Date().toLocaleDateString('es-PY')
    const recNom    = doc.receptor_razon || doc.receptorRazon || 'Cliente'
    const recRuc    = doc.receptor_doc   || doc.receptorDoc   || ''

    // Variables de reemplazo en plantillas
    const vars = {
      tipoDocumento:   tipoDoc,
      numeroFactura:   numero,
      receptor_nombre: recNom,
      receptor_ruc:    recRuc,
      emisor_nombre:   emisorNom,
      emisor_ruc:      emisorRuc,
      monto_total:     monto,
      fecha,
      cdc:             doc.cdc || '',
      emisor_telefono: tenant.telefono || '',
      emisor_email:    tenant.smtpFrom || tenant.smtp_from || tenant.email || '',
    }
    const reemplazar = (str) => str.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`)

    // Usar plantillas del tenant o valores por defecto
    const ASUNTO_DEFAULT = '${tipoDocumento} N° ${numeroFactura} — ${emisor_nombre}'
    const CUERPO_DEFAULT = `Estimado/a \${receptor_nombre},\n\nAdjunto encontrará su \${tipoDocumento} N° \${numeroFactura} emitida por \${emisor_nombre} (RUC: \${emisor_ruc}), aprobada por la SET de Paraguay.\n\nMonto total: \${monto_total}\nFecha de emisión: \${fecha}\nCDC: \${cdc}\n\nEl archivo PDF adjunto es el comprobante oficial (KUDE). Puede verificar su autenticidad en ekuatia.set.gov.py ingresando el CDC.`
    const FIRMA_DEFAULT  = `Atentamente,\n\${emisor_nombre}`

    const asuntoPlantilla = tenant.email_asunto         || tenant.emailAsunto         || ASUNTO_DEFAULT
    const cuerpoPlantilla = tenant.email_cuerpo         || tenant.emailCuerpo         || CUERPO_DEFAULT
    const infoAdicional   = tenant.email_info_adicional || tenant.emailInfoAdicional  || ''
    const firmaPlantilla  = tenant.email_firma          || tenant.emailFirma          || FIRMA_DEFAULT

    // Construir texto completo con secciones
    const partesTexto = [reemplazar(cuerpoPlantilla)]
    if (infoAdicional.trim()) partesTexto.push('\n─────────────────\n' + infoAdicional.trim())
    partesTexto.push('\n' + reemplazar(firmaPlantilla))
    const cuerpoTexto = partesTexto.join('\n')

    const asunto = reemplazar(asuntoPlantilla)

    // HTML wrapper para el cuerpo de texto
    const html = plantillaEmail({
      tipoDoc, numero, emisorNom, emisorRuc,
      receptorNom: recNom, monto, cdc: doc.cdc,
      cuerpoTexto,
    })

    const adjunto = {
      filename:    `KUDE-${numero.replace(/[^0-9\-]/g, '')}.pdf`,
      content:     pdfBytes,
      contentType: 'application/pdf',
    }

    const fromAddr = tenant.smtpFrom || tenant.smtp_from || tenant.email || ''
    const fromName = tenant.smtpFromName || tenant.smtp_from_name || emisorNom
    const from = fromName ? `"${fromName}" <${fromAddr}>` : fromAddr

    const destinatarios = []

    // Email al receptor (cliente)
    if (emailReceptor) {
      destinatarios.push({ to: emailReceptor, tipo: 'receptor' })
    }

    // Copia al emisor
    const emailEmisorFinal = tenant.smtpFrom || tenant.smtp_from || tenant.email || null
    if (emailEmisorFinal && emailEmisorFinal !== emailReceptor) {
      destinatarios.push({ to: emailEmisorFinal, tipo: 'emisor' })
    }

    for (const dest of destinatarios) {
      try {
        await transporte.sendMail({
          from,
          to:      dest.to,
          subject: asunto,
          html,
          attachments: [adjunto],
        })
        console.log(`[EMAIL] ✓ Enviado a ${dest.to} (${dest.tipo})`)
        await registrarEmailLog(doc.id, dest.to, dest.tipo, 'enviado', null)
      } catch (err) {
        console.error(`[EMAIL] ✗ Error enviando a ${dest.to}:`, err.message)
        await registrarEmailLog(doc.id, dest.to, dest.tipo, 'error', err.message)
      }
    }

  } catch (err) {
    console.error('[EMAIL] Error general:', err.message)
    await registrarEmailLog(doc.id, null, null, 'error', err.message)
  }
}

// ── Template HTML del email ───────────────────────────────────────────────────

function plantillaEmail({ tipoDoc, numero, emisorNom, emisorRuc, receptorNom, monto, cdc, cuerpoTexto }) {
  // Si hay cuerpo personalizado, usarlo como texto plano dentro del wrapper HTML
  const cuerpoHtml = cuerpoTexto
    ? cuerpoTexto.split('\n').map(l => l ? `<p style="margin:0 0 10px">${l}</p>` : '<br>').join('')
    : `<p style="margin:0 0 10px">Estimado/a <strong>${receptorNom}</strong>,</p>
       <p style="margin:0 0 10px">Adjunto encontrará su <strong>${tipoDoc}</strong> N° <strong>${numero}</strong> emitida por <strong>${emisorNom}</strong> y aprobada por la Subsecretaría de Estado de Tributación (SET) de Paraguay.</p>`
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${tipoDoc} N° ${numero}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="background:#1a1a2e;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:#FF8C00;letter-spacing:-0.5px">NODO <span style="color:#ffffff;font-weight:400">Engine</span></div>
          <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px">Facturación Electrónica — SET Paraguay</div>
        </td></tr>

        <!-- Cuerpo -->
        <tr><td style="background:#ffffff;padding:32px">

          <div style="font-size:14px;color:#374151;line-height:1.7;margin-bottom:24px">
            ${cuerpoHtml}
          </div>

          <!-- Datos del documento -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px">
            <tr>
              <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Tipo de documento</div>
                <div style="font-size:14px;color:#111827;font-weight:600">${tipoDoc}</div>
              </td>
              <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Número</div>
                <div style="font-size:14px;color:#111827;font-weight:600;font-family:monospace">${numero}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Emisor</div>
                <div style="font-size:14px;color:#111827">${emisorNom}</div>
                <div style="font-size:12px;color:#6b7280">RUC: ${emisorRuc}</div>
              </td>
              <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Monto total</div>
                <div style="font-size:18px;color:#111827;font-weight:700">${monto}</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding:16px 20px">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">CDC (código de control)</div>
                <div style="font-size:11px;color:#374151;font-family:monospace;word-break:break-all">${cdc}</div>
              </td>
            </tr>
          </table>

          <!-- Estado -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:24px">
            <tr>
              <td style="padding:16px 20px;display:flex;align-items:center;gap:10px">
                <span style="font-size:20px">✅</span>
                <div>
                  <div style="font-size:13px;font-weight:600;color:#166534">Documento aprobado por la SET</div>
                  <div style="font-size:12px;color:#4ade80">Código de respuesta: 0260 — Documento válido y registrado</div>
                </div>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6">
            El archivo PDF adjunto es el <strong>KUDE (Kuatia Electrónica)</strong>, el comprobante oficial de este documento electrónico. Podés conservarlo como respaldo digital.
          </p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6">
            Podés verificar la autenticidad de este documento ingresando el CDC en el portal de la SET:
            <a href="https://ekuatia.set.gov.py" style="color:#FF8C00">ekuatia.set.gov.py</a>
          </p>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center">
          <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6">
            Este correo fue generado automáticamente por <strong>NODO Engine</strong> — Sistema de Facturación Electrónica.<br>
            Emisor: ${emisorNom} · RUC: ${emisorRuc}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ── Log de emails enviados ────────────────────────────────────────────────────

async function registrarEmailLog(docId, destinatario, tipo, estado, error) {
  try {
    const sql = getDb()
    await sql`
      INSERT INTO email_logs (documento_id, destinatario, tipo, estado, error, enviado_en)
      VALUES (${docId}, ${destinatario}, ${tipo}, ${estado}, ${error}, NOW())
    `.catch(() => {}) // Si la tabla no existe aún, ignorar
  } catch {}
}
