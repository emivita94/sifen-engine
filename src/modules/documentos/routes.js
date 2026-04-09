// src/modules/documentos/routes.js
import { procesarDocumento, cancelarDocumento, inutilizarDocumentos, procesarDocumentoERP, validarDocumento } from '../sifen/motor.js'
import { getDb } from '../../db/connection.js'
import { generarKude } from '../sifen/kude.js'
import { hashApiKey } from '../../shared/crypto/index.js'
import { z } from 'zod'

const itemSchema = z.object({
  descripcion:    z.string().min(1).max(500),
  cantidad:       z.number().positive(),
  precioUnitario: z.number().positive(),
  precioTotal:    z.number().positive(),
  tasaIVA:        z.union([z.literal(0), z.literal(5), z.literal(10)]),
})

const receptorSchema = z.object({
  tipo:        z.number().int().min(1).max(4),
  documento:   z.string().optional(),
  razonSocial: z.string().optional(),
  pais:        z.string().length(3).optional().default('PRY'),
  email:       z.string().email().optional(),
})

const emitirSchema = z.object({
  tipoDocumento:         z.number().int().default(1),
  tipoTransaccion:       z.number().int().default(1),
  fecha:                 z.string().optional(),
  moneda:                z.string().default('PYG'),
  receptor:              receptorSchema,
  items:                 z.array(itemSchema).min(1),
  referenciaExterna:     z.string().max(100).optional(),
  webhookUrl:            z.string().url().optional(),
  // Nota de Credito / Debito (tipo 5 o 6)
  motivo:                z.number().int().optional(),          // 1=Devolucion, 2=Cancelacion...
  cdcDocumentoAsociado:  z.string().length(44).optional(),    // CDC de la factura original
  // Nota de Remision (tipo 7)
  motivoRemision:        z.number().int().optional(),
  tipoResponsable:       z.number().int().optional(),
}).passthrough()

// ── Auth ──────────────────────────────────────────────────────────────────────
async function autenticar(request, reply) {
  const sql = getDb()
  const authHeader = request.headers['x-api-key'] || request.headers['authorization']
  if (!authHeader) {
    return reply.status(401).send({ error: 'Sin autenticacion. Inclui el header X-API-Key.' })
  }
  const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  if (!key.startsWith('sk_')) {
    return reply.status(401).send({ error: 'Formato de API key invalido' })
  }

  const hash = hashApiKey(key)
  const [row] = await sql`
    SELECT
      ak.id        AS key_id,
      ak.tenant_id,
      ak.activa,
      ak.expira_en,
      t.nombre,
      t.ruc,
      t.razon_social,
      t.ambiente,
      t.activo          AS tenant_activo,
      t.certificado_enc,
      t.cert_alias,
      t.codigo_seguridad
    FROM api_keys ak
    JOIN tenants t ON t.id = ak.tenant_id
    WHERE ak.key_hash = ${hash}
  `

  if (!row)              return reply.status(401).send({ error: 'API key invalido' })
  if (!row.activa)       return reply.status(401).send({ error: 'API key desactivado' })
  if (!row.tenantActivo) return reply.status(403).send({ error: 'Tenant inactivo' })

  request.tenant = {
    id:              row.tenantId,
    nombre:          row.nombre,
    ruc:             row.ruc,
    razonSocial:     row.razonSocial,
    ambiente:        row.ambiente,
    certificadoEnc:  row.certificadoEnc,
    certAlias:       row.certAlias,
    codigoSeguridad: row.codigoSeguridad,
  }

  sql`UPDATE api_keys SET ultimo_uso = now() WHERE id = ${row.keyId}`.catch(() => {})
}

export async function documentosRoutes(fastify) {

  fastify.addHook('preHandler', autenticar)

  // ─── POST /documentos ─────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const parse = emitirSchema.safeParse(request.body)
    if (!parse.success) {
      return reply.status(400).send({ error: 'Datos invalidos', detalles: parse.error.flatten() })
    }
    try {
      const resultado = await procesarDocumento(request.tenant.id, parse.data)
      return reply.status(resultado.ok ? 201 : 422).send({ ok: resultado.ok, data: resultado })
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error procesando documento', mensaje: err.message })
    }
  })

  // ─── POST /documentos/erp ────────────────────────────────────────────────
  // Endpoint para integración directa con ERP — acepta el formato nativo del ERP
  fastify.post('/erp', async (request, reply) => {
    const body = request.body
    if (!body || !body.tipoDocumento || !body.items || !body.cliente) {
      return reply.status(400).send({ error: 'Faltan campos requeridos: tipoDocumento, items, cliente' })
    }
    try {
      const resultado = await procesarDocumentoERP(request.tenant.id, body)
      return reply.status(resultado.ok ? 201 : 422).send({ ok: resultado.ok, data: resultado })
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error procesando documento ERP', mensaje: err.message })
    }
  })

  // ─── POST /documentos/validar ──────────────────────────────────────────────
  // Dry-run: valida el payload completo sin emitir, firmar ni enviar a SIFEN.
  // Acepta ambos formatos (estándar y ERP).
  fastify.post('/validar', async (request, reply) => {
    const body = request.body
    if (!body) {
      return reply.status(400).send({ error: 'Body vacío' })
    }

    // Detectar formato: si tiene "cliente" es formato ERP, si tiene "receptor" es estándar
    const esERP = !!body.cliente
    const formato = esERP ? 'erp' : 'estandar'

    // Validación Zod solo para formato estándar
    if (!esERP) {
      const parse = emitirSchema.safeParse(body)
      if (!parse.success) {
        return reply.status(400).send({
          ok: false,
          valido: false,
          errores: parse.error.issues.map(issue => ({
            campo:   issue.path.join('.'),
            mensaje: issue.message,
          })),
        })
      }
    } else {
      if (!body.items || !body.cliente) {
        return reply.status(400).send({
          ok: false,
          valido: false,
          errores: [{ campo: 'body', mensaje: 'Formato ERP requiere campos: tipoDocumento, items, cliente' }],
        })
      }
    }

    try {
      const resultado = await validarDocumento(request.tenant.id, body, formato)
      return reply.status(resultado.valido ? 200 : 422).send(resultado)
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error validando documento', mensaje: err.message })
    }
  })

  // ─── POST /documentos/inutilizar ─────────────────────────────────────────
  // IMPORTANTE: debe ir antes de /:cdc para que Fastify no lo confunda
  fastify.post('/inutilizar', async (request, reply) => {
    const { tipoDocumento, establecimiento, punto, desde, hasta, motivo } = request.body || {}
    if (!desde || !hasta) {
      return reply.status(400).send({ error: 'Se requieren los campos desde y hasta' })
    }
    if (Number(desde) > Number(hasta)) {
      return reply.status(400).send({ error: 'El campo desde no puede ser mayor que hasta' })
    }
    try {
      const resultado = await inutilizarDocumentos(request.tenant.id, {
        tipoDocumento: tipoDocumento || 1,
        establecimiento,
        punto,
        desde:  Number(desde),
        hasta:  Number(hasta),
        motivo: motivo || 'Documentos no utilizados',
      })
      if (!resultado.ok) {
        return reply.status(422).send({ error: resultado.error?.mensaje || 'No se pudo inutilizar' })
      }
      return { ok: true, data: resultado }
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error inutilizando documentos', mensaje: err.message })
    }
  })

  // ─── GET /documentos ──────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const sql = getDb()
    const { estado, desde, hasta, limit = 20, offset = 0, ref_ext } = request.query

    const docs = await sql`
      SELECT id, cdc, tipo_documento, numero, estado,
             receptor_razon, receptor_doc, monto_total,
             sifen_codigo, sifen_mensaje, referencia_ext,
             creado_en, actualizado_en
      FROM documentos
      WHERE tenant_id = ${request.tenant.id}
        ${estado  ? sql`AND estado = ${estado}` : sql``}
        ${desde   ? sql`AND creado_en >= ${desde}::date` : sql``}
        ${hasta   ? sql`AND creado_en <= ${hasta}::date + interval '1 day'` : sql``}
        ${ref_ext ? sql`AND referencia_ext = ${ref_ext}` : sql``}
      ORDER BY creado_en DESC
      LIMIT ${limit} OFFSET ${offset}
    `
    const [{ total }] = await sql`
      SELECT COUNT(*) AS total FROM documentos
      WHERE tenant_id = ${request.tenant.id}
        ${estado  ? sql`AND estado = ${estado}` : sql``}
        ${desde   ? sql`AND creado_en >= ${desde}::date` : sql``}
        ${hasta   ? sql`AND creado_en <= ${hasta}::date + interval '1 day'` : sql``}
        ${ref_ext ? sql`AND referencia_ext = ${ref_ext}` : sql``}
    `
    return { ok: true, data: docs, total: Number(total), limit, offset }
  })

  // ─── GET /documentos/:cdc ─────────────────────────────────────────────────
  fastify.get('/:cdc', async (request, reply) => {
    const sql = getDb()
    const [doc] = await sql`
      SELECT * FROM documentos
      WHERE cdc = ${request.params.cdc} AND tenant_id = ${request.tenant.id}
    `
    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })
    return { ok: true, data: doc }
  })

  // ─── GET /documentos/:cdc/xml ─────────────────────────────────────────────
  fastify.get('/:cdc/xml', async (request, reply) => {
    const sql = getDb()
    const [doc] = await sql`
      SELECT cdc, xml_firmado, xml_aprobado FROM documentos
      WHERE cdc = ${request.params.cdc} AND tenant_id = ${request.tenant.id}
    `
    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })
    reply.header('Content-Type', 'application/xml')
    reply.header('Content-Disposition', `attachment; filename="${doc.cdc}.xml"`)
    return doc.xmlAprobado || doc.xmlFirmado
  })

  // ─── GET /documentos/:cdc/kude ────────────────────────────────────────────
  fastify.get('/:cdc/kude', async (request, reply) => {
    const sql = getDb()
    const { cdc } = request.params
    const formato = request.query.formato || 'a4'

    const [doc] = await sql`
      SELECT * FROM documentos
      WHERE cdc = ${cdc} AND tenant_id = ${request.tenant.id}
    `
    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })

    const [tenant] = await sql`
      SELECT ruc, razon_social, direccion, email, telefono,
             actividades_economicas, nombre_fantasia, logo_url
      FROM tenants WHERE id = ${request.tenant.id}
    `

    // Datos del timbrado
    if (doc.timbradoId) {
      const [timbrado] = await sql`
        SELECT numero_timbrado, vigencia_desde FROM timbrados WHERE id = ${doc.timbradoId}
      `
      if (timbrado) {
        doc.timbradoNumero        = timbrado.numeroTimbrado
        doc.timbradoVigenciaDesde = timbrado.vigenciaDesde
      }
    }

    // Generar QR
    let qrBase64 = null
    const xmlParaQR = doc.xmlFirmado || ''
    if (doc.estado === 'aprobado' && xmlParaQR) {
      try {
        const qrMatch = String(xmlParaQR).match(/dCarQR>([^<]+)</)
        if (qrMatch) {
          const qrUrl = qrMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
          const QRCode = await import('qrcode')
          qrBase64 = await QRCode.default.toDataURL(qrUrl, { type: 'image/png', width: 200, margin: 1 })
        }
      } catch (e) { console.log('QR error:', e.message) }
    }

    try {
      const pdfBytes = await generarKude(doc, tenant, formato, qrBase64)
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `inline; filename="KUDE-${(doc.numero || cdc).replace(/\//g, '-')}.pdf"`)
      reply.header('Content-Length', pdfBytes.length)
      return reply.send(Buffer.from(pdfBytes))
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error generando KUDE', mensaje: err.message })
    }
  })

  // ─── POST /documentos/:cdc/cancelar ──────────────────────────────────────
  fastify.post('/:cdc/cancelar', async (request, reply) => {
    const { cdc } = request.params
    const motivo  = request.body?.motivo || 'Cancelacion solicitada por el emisor'
    try {
      const resultado = await cancelarDocumento(request.tenant.id, cdc, motivo)
      if (!resultado.ok) {
        return reply.status(422).send({
          error:   resultado.error?.mensaje || 'No se pudo cancelar',
          detalles: resultado.error?.detalles || null,
        })
      }
      return { ok: true, data: resultado }
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error cancelando documento', mensaje: err.message })
    }
  })

  // ─── POST /documentos/:cdc/reenviar-email ────────────────────────────────
  fastify.post('/:cdc/reenviar-email', async (request, reply) => {
    const { cdc }         = request.params
    const emailDestino    = request.body?.emailDestino || null
    const tenantId        = request.tenant.id
    const sql             = getDb()

    // Buscar el documento
    const [doc] = await sql`
      SELECT d.*, t.email AS tenant_email,
             t.smtp_host, t.smtp_port, t.smtp_ssl, t.smtp_user, t.smtp_pass,
             t.smtp_from, t.smtp_from_name, t.nombre_fantasia, t.razon_social, t.ruc
      FROM documentos d
      JOIN tenants t ON t.id = d.tenant_id
      WHERE d.cdc = ${cdc} AND d.tenant_id = ${tenantId}
    `

    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })
    if (doc.estado !== 'aprobado') return reply.status(400).send({ error: 'Solo se puede reenviar el email de documentos aprobados' })

    try {
      const { enviarEmailDocumento } = await import('../sifen/email.js')

      // Si se especificó un email destino, usarlo temporalmente
      const docParaEnvio = emailDestino
        ? { ...doc, receptor_email: emailDestino }
        : doc

      const tenant = {
        id: tenantId,
        ruc:           doc.ruc,
        razonSocial:   doc.razonSocial   || doc.razon_social,
        nombreFantasia: doc.nombreFantasia || doc.nombre_fantasia,
        email:         doc.tenantEmail   || doc.tenant_email,
        // postgres-js convierte snake_case → camelCase automáticamente
        smtpHost:     doc.smtpHost     || doc.smtp_host,
        smtpPort:     doc.smtpPort     || doc.smtp_port,
        smtpSsl:      doc.smtpSsl      ?? doc.smtp_ssl,
        smtpUser:     doc.smtpUser     || doc.smtp_user,
        smtpPass:     doc.smtpPass     || doc.smtp_pass,
        smtpFrom:     doc.smtpFrom     || doc.smtp_from,
        smtpFromName: doc.smtpFromName || doc.smtp_from_name,
      }

      await enviarEmailDocumento(docParaEnvio, tenant)
      return { ok: true, mensaje: 'Email enviado correctamente' }

    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ error: 'Error enviando email: ' + err.message })
    }
  })

}
