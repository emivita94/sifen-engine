// src/modules/tenants/health.js
// Endpoint GET /api/v1/tenants/:id/health
// Retorna el estado operativo del tenant (requiere autenticación)

import { getDb } from '../../db/connection.js'

export async function tenantHealthRoute(fastify) {

  fastify.get('/:id/health', async (request, reply) => {
    const sql = getDb()
    const tenantId = request.params.id

    // ── Tenant ──────────────────────────────────────────────────────────────
    const [tenant] = await sql`
      SELECT id, activo, ambiente,
             certificado_enc, cert_alias, cert_vencimiento,
             smtp_host, csc, id_csc
      FROM tenants WHERE id = ${tenantId}
    `

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant no encontrado' })
    }

    // ── Certificado ─────────────────────────────────────────────────────────
    const certCargado = !!tenant.certificadoEnc || !!tenant.certificado_enc
    let certInfo = { cargado: false }

    if (certCargado) {
      const alias = tenant.certAlias || tenant.cert_alias || null
      const vencimientoRaw = tenant.certVencimiento || tenant.cert_vencimiento || null
      let venceEn = null
      let diasRestantes = null
      let estado = null

      if (vencimientoRaw) {
        const vencDate = new Date(vencimientoRaw)
        venceEn = vencDate.toISOString().split('T')[0]
        const hoy = new Date()
        hoy.setHours(0, 0, 0, 0)
        diasRestantes = Math.ceil((vencDate - hoy) / (1000 * 60 * 60 * 24))

        if (diasRestantes <= 0) {
          estado = 'vencido'
        } else if (diasRestantes <= 30) {
          estado = 'por_vencer'
        } else {
          estado = 'vigente'
        }
      }

      certInfo = {
        cargado: true,
        alias,
        venceEn,
        diasRestantes,
        estado,
      }
    }

    // ── Timbrado activo ─────────────────────────────────────────────────────
    const [timbrado] = await sql`
      SELECT numero_timbrado, vigencia_hasta, numero_actual, numero_max, activo
      FROM timbrados
      WHERE tenant_id = ${tenantId} AND activo = true
      ORDER BY creado_en DESC
      LIMIT 1
    `

    let timbradoInfo = { activo: false }

    if (timbrado) {
      const vencDate = new Date(timbrado.vigenciaHasta || timbrado.vigencia_hasta)
      const venceEn = vencDate.toISOString().split('T')[0]
      const hoy = new Date()
      hoy.setHours(0, 0, 0, 0)
      const diasRestantes = Math.ceil((vencDate - hoy) / (1000 * 60 * 60 * 24))
      const numActual = Number(timbrado.numeroActual ?? timbrado.numero_actual ?? 1)
      const numMax = Number(timbrado.numeroMax ?? timbrado.numero_max ?? 9999999)
      const numerosDisponibles = Math.max(0, numMax - numActual + 1)

      timbradoInfo = {
        activo: true,
        numero: timbrado.numeroTimbrado || timbrado.numero_timbrado,
        venceEn,
        diasRestantes,
        numerosDisponibles,
      }
    }

    // ── SMTP ────────────────────────────────────────────────────────────────
    const smtpHost = tenant.smtpHost || tenant.smtp_host || null
    const smtpConfigurado = !!smtpHost

    // ── CSC ─────────────────────────────────────────────────────────────────
    const cscVal = tenant.csc || null
    const cscConfigurado = !!cscVal

    // ── Respuesta ───────────────────────────────────────────────────────────
    return {
      ok: true,
      tenant: {
        activo: tenant.activo,
        ambiente: tenant.ambiente,
      },
      certificado: certInfo,
      timbrado: timbradoInfo,
      smtp: {
        configurado: smtpConfigurado,
      },
      csc: {
        configurado: cscConfigurado,
      },
    }
  })
}
