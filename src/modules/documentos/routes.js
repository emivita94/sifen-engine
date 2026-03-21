// src/modules/documentos/routes.js
// Endpoints REST para emitir, consultar y gestionar DEs

import { procesarDocumento } from '../sifen/motor.js'
import { getDb } from '../../db/connection.js'
import { generarKude } from '../sifen/kude.js'
import { z } from 'zod'

// Schema Zod de validación mínima para una factura
const itemSchema = z.object({
  descripcion:    z.string().min(1).max(500),
  cantidad:       z.number().positive(),
  precioUnitario: z.number().positive(),
  precioTotal:    z.number().positive(),
  tasaIVA:        z.union([z.literal(0), z.literal(5), z.literal(10)]),
})

const receptorSchema = z.object({
  tipo:        z.number().int().min(1).max(4),   // 1=RUC 2=CI 3=Pasaporte 4=Innominado
  documento:   z.string().optional(),
  razonSocial: z.string().optional(),
  pais:        z.string().length(3).optional().default('PRY'),
  email:       z.string().email().optional(),
})

const emitirSchema = z.object({
  tipoDocumento:    z.number().int().default(1),
  tipoTransaccion:  z.number().int().default(1),
  fecha:            z.string().optional(),       // ISO date, default: ahora
  moneda:           z.string().default('PYG'),
  receptor:         receptorSchema,
  items:            z.array(itemSchema).min(1),
  // Opcionales de control
  referenciaExterna: z.string().max(100).optional(),
  webhookUrl:        z.string().url().optional(),
  // Campos extra se pasan directo a xmlgen
}).passthrough()

export async function documentosRoutes(fastify) {

  // ─── POST /documentos - Emitir un DE ─────────────────────────────────────
  fastify.post('/', {
    schema: {
      description: 'Emite un Documento Electrónico y lo envía a SIFEN',
      tags: ['Documentos'],
      security: [{ apiKey: [] }],
    },
  }, async (request, reply) => {
    const parse = emitirSchema.safeParse(request.body)
    if (!parse.success) {
      return reply.status(400).send({
        error: 'Datos inválidos',
        detalles: parse.error.flatten(),
      })
    }

    try {
      const resultado = await procesarDocumento(
        request.tenant.id,
        parse.data
      )

      return reply.status(resultado.aprobado ? 201 : 422).send({
        ok: resultado.aprobado,
        data: resultado,
      })
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({
        error: 'Error procesando documento',
        mensaje: err.message,
      })
    }
  })

  // ─── GET /documentos - Listar DEs del tenant ──────────────────────────────
  fastify.get('/', {
    schema: {
      description: 'Lista DEs del tenant con filtros opcionales',
      tags: ['Documentos'],
      security: [{ apiKey: [] }],
      querystring: {
        type: 'object',
        properties: {
          estado:  { type: 'string', enum: ['pendiente','firmado','aprobado','rechazado','cancelado'] },
          desde:   { type: 'string', format: 'date' },
          hasta:   { type: 'string', format: 'date' },
          limit:   { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset:  { type: 'integer', minimum: 0, default: 0 },
          ref_ext: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { estado, desde, hasta, limit = 20, offset = 0, ref_ext } = request.query

    const docs = await sql`
      SELECT id, cdc, tipo_documento, numero, estado,
             receptor_razon, receptor_doc, monto_total,
             sifen_codigo, sifen_mensaje, referencia_ext,
             creado_en, actualizado_en
      FROM documentos
      WHERE tenant_id = ${request.tenant.id}
        ${estado    ? sql`AND estado = ${estado}` : sql``}
        ${desde     ? sql`AND creado_en >= ${desde}::date` : sql``}
        ${hasta     ? sql`AND creado_en <= ${hasta}::date + interval '1 day'` : sql``}
        ${ref_ext   ? sql`AND referencia_ext = ${ref_ext}` : sql``}
      ORDER BY creado_en DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ total }] = await sql`
      SELECT COUNT(*) AS total
      FROM documentos
      WHERE tenant_id = ${request.tenant.id}
        ${estado    ? sql`AND estado = ${estado}` : sql``}
        ${desde     ? sql`AND creado_en >= ${desde}::date` : sql``}
        ${hasta     ? sql`AND creado_en <= ${hasta}::date + interval '1 day'` : sql``}
        ${ref_ext   ? sql`AND referencia_ext = ${ref_ext}` : sql``}
    `

    return { ok: true, data: docs, total: Number(total), limit, offset }
  })

  // ─── GET /documentos/:cdc - Obtener DE por CDC ────────────────────────────
  fastify.get('/:cdc', {
    schema: {
      description: 'Obtiene un DE por su CDC',
      tags: ['Documentos'],
      security: [{ apiKey: [] }],
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { cdc } = request.params

    const [doc] = await sql`
      SELECT * FROM documentos
      WHERE cdc = ${cdc} AND tenant_id = ${request.tenant.id}
    `

    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })

    return { ok: true, data: doc }
  })

  // ─── GET /documentos/:cdc/xml - Descargar XML firmado ─────────────────────
  fastify.get('/:cdc/xml', async (request, reply) => {
    const sql = getDb()
    const [doc] = await sql`
      SELECT cdc, xml_firmado, xml_aprobado
      FROM documentos
      WHERE cdc = ${request.params.cdc}
        AND tenant_id = ${request.tenant.id}
    `

    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })

    reply.header('Content-Type', 'application/xml')
    reply.header('Content-Disposition', `attachment; filename="${doc.cdc}.xml"`)
    return doc.xmlAprobado || doc.xmlFirmado
  })

  // ─── GET /documentos/:cdc/kude - Descargar KUDE PDF ──────────────────────
  // ?formato=a4        → PDF A4 (default)
  // ?formato=ticket80  → Ticket 80mm
  // ?formato=ticket58  → Ticket 58mm
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
      SELECT ruc, razon_social, direccion, email, telefono
      FROM tenants WHERE id = ${request.tenant.id}
    `

    // Generar QR si el documento está aprobado
    let qrBase64 = null
    if (doc.estado === 'aprobado' && doc.cdc) {
      try {
        const qrgen = (await import('facturacionelectronicapy-qrgen')).default
        const urlConsulta = `https://ekuatia.set.gov.py/consultas/qr?nVersion=150&Id=${doc.cdc}`
        qrBase64 = await qrgen.generateQR(urlConsulta, { type: 'image/png', quality: 0.92 })
      } catch (e) {
        // Continuar sin QR si falla
      }
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

  // ─── POST /documentos/:cdc/cancelar ───────────────────────────────────────
  fastify.post('/:cdc/cancelar', {
    schema: {
      body: {
        type: 'object',
        required: ['motivo'],
        properties: {
          motivo: { type: 'string', minLength: 5 }
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { cdc } = request.params
    const { motivo } = request.body

    const [doc] = await sql`
      SELECT id, estado FROM documentos
      WHERE cdc = ${cdc} AND tenant_id = ${request.tenant.id}
    `

    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })
    if (doc.estado !== 'aprobado') {
      return reply.status(400).send({
        error: `No se puede cancelar un documento en estado: ${doc.estado}`
      })
    }

    await sql`
      UPDATE documentos SET estado = 'cancelado' WHERE id = ${doc.id}
    `

    return { ok: true, mensaje: 'Cancelación enviada a SIFEN' }
  })

}
