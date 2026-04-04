// src/modules/tenants/routes.js
// CRUD de tenants: registro, certificados, establecimientos, puntos, timbrados

import { getDb } from '../../db/connection.js'
import { encriptar, generarApiKey } from '../../shared/crypto/index.js'

export async function tenantsRoutes(fastify) {

  // ─── POST /tenants - Crear tenant nuevo ───────────────────────────────────
  fastify.post('/', {
    // Este endpoint debería estar protegido con un token de admin, no de tenant
    // Por ahora usa el mismo JWT del servidor
    schema: {
      body: {
        type: 'object',
        required: ['nombre', 'ruc', 'razonSocial'],
        properties: {
          nombre:      { type: 'string' },
          ruc:         { type: 'string', pattern: '^\\d{1,8}-\\d{1}$' },
          razonSocial: { type: 'string' },
          ambiente:    { type: 'string', enum: ['test', 'prod'], default: 'test' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { nombre, ruc, razonSocial, ambiente = 'test' } = request.body

    // Verificar RUC único
    const [existe] = await sql`SELECT id FROM tenants WHERE ruc = ${ruc}`
    if (existe) return reply.status(409).send({ error: 'Ya existe un tenant con ese RUC' })

    const [tenant] = await sql`
      INSERT INTO tenants (nombre, ruc, razon_social, ambiente)
      VALUES (${nombre}, ${ruc}, ${razonSocial}, ${ambiente})
      RETURNING id, nombre, ruc, razon_social, ambiente, activo, creado_en
    `

    // Crear primera API key automáticamente
    const { key, hash, prefix } = generarApiKey(ambiente === 'prod' ? 'live' : 'test')
    await sql`
      INSERT INTO api_keys (tenant_id, nombre, key_hash, key_prefix, key_plain)
      VALUES (${tenant.id}, 'Default', ${hash}, ${prefix}, ${key})
    `

    return reply.status(201).send({
      ok: true,
      data: {
        ...tenant,
        // Solo se muestra el key UNA VEZ al crear
        apiKey: key,
        apiKeyPrefix: prefix,
      }
    })
  })

  // ─── GET /tenants/:id ─────────────────────────────────────────────────────
  fastify.get('/:id', async (request, reply) => {
    const sql = getDb()
    const [tenant] = await sql`
      SELECT id, nombre, ruc, razon_social, ambiente,
             cert_alias, cert_vencimiento, activo, plan, creado_en
      FROM tenants WHERE id = ${request.params.id}
    `
    if (!tenant) return reply.status(404).send({ error: 'Tenant no encontrado' })
    return { ok: true, data: tenant }
  })

  // ─── POST /tenants/:id/certificado - Subir certificado PKCS#12 ───────────
  // El certificado llega como base64 en el body (no multipart para simplicidad)
  fastify.post('/:id/certificado', {
    schema: {
      body: {
        type: 'object',
        required: ['certificadoBase64', 'alias'],
        properties: {
          certificadoBase64: { type: 'string' },  // PKCS#12 en base64
          alias:             { type: 'string' },
          password:          { type: 'string' },   // password del cert (también encriptado)
          vencimiento:       { type: 'string', format: 'date' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { certificadoBase64, alias, vencimiento } = request.body

    // Validar que es un buffer válido
    let certBuffer
    try {
      certBuffer = Buffer.from(certificadoBase64, 'base64')
      if (certBuffer.length < 100) throw new Error('Certificado demasiado pequeño')
    } catch {
      return reply.status(400).send({ error: 'certificadoBase64 inválido' })
    }

    // Encriptar antes de guardar en BD
    const certEncriptado = encriptar(certBuffer)

    await sql`
      UPDATE tenants SET
        certificado_enc  = ${certEncriptado},
        cert_alias       = ${alias},
        cert_vencimiento = ${vencimiento || null},
        actualizado_en   = now()
      WHERE id = ${request.params.id}
    `

    return { ok: true, mensaje: 'Certificado cargado y encriptado correctamente' }
  })

  // ─── POST /tenants/:id/establecimientos ───────────────────────────────────
  fastify.post('/:id/establecimientos', {
    schema: {
      body: {
        type: 'object',
        required: ['codigo', 'nombre'],
        properties: {
          codigo:             { type: 'string', pattern: '^\\d{3}$' },
          nombre:             { type: 'string' },
          direccion:          { type: 'string' },
          ciudadCodigo:       { type: 'integer' },
          ciudadNombre:       { type: 'string' },
          departamentoCodigo: { type: 'integer' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { codigo, nombre, direccion, ciudadCodigo, ciudadNombre, departamentoCodigo } = request.body

    const [estab] = await sql`
      INSERT INTO establecimientos (
        tenant_id, codigo, nombre, direccion,
        ciudad_codigo, ciudad_nombre, departamento_codigo
      ) VALUES (
        ${request.params.id}, ${codigo}, ${nombre}, ${direccion || null},
        ${ciudadCodigo || null}, ${ciudadNombre || null}, ${departamentoCodigo || null}
      )
      ON CONFLICT (tenant_id, codigo) DO NOTHING
      RETURNING *
    `

    if (!estab) return reply.status(409).send({ error: 'Ya existe un establecimiento con ese código' })
    return reply.status(201).send({ ok: true, data: estab })
  })

  // ─── POST /tenants/:id/establecimientos/:estId/puntos ─────────────────────
  fastify.post('/:id/establecimientos/:estId/puntos', {
    schema: {
      body: {
        type: 'object',
        required: ['codigo'],
        properties: {
          codigo:      { type: 'string', pattern: '^\\d{3}$' },
          descripcion: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { codigo, descripcion } = request.body

    const [punto] = await sql`
      INSERT INTO puntos_expedicion (establecimiento_id, tenant_id, codigo, descripcion)
      VALUES (
        ${request.params.estId}, ${request.params.id},
        ${codigo}, ${descripcion || null}
      )
      ON CONFLICT (establecimiento_id, codigo) DO NOTHING
      RETURNING *
    `

    if (!punto) return reply.status(409).send({ error: 'Ya existe un punto con ese código' })
    return reply.status(201).send({ ok: true, data: punto })
  })

  // ─── POST /tenants/:id/timbrados ──────────────────────────────────────────
  fastify.post('/:id/timbrados', {
    schema: {
      body: {
        type: 'object',
        required: ['establecimientoId', 'puntoId', 'numeroTimbrado', 'tipoDocumento', 'vigenciaDesde', 'vigenciaHasta'],
        properties: {
          establecimientoId: { type: 'string', format: 'uuid' },
          puntoId:           { type: 'string', format: 'uuid' },
          numeroTimbrado:    { type: 'string', pattern: '^\\d{8}$' },
          tipoDocumento:     { type: 'integer', minimum: 1, maximum: 7 },
          numeroMax:         { type: 'integer', default: 9999999 },
          vigenciaDesde:     { type: 'string', format: 'date' },
          vigenciaHasta:     { type: 'string', format: 'date' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const body = request.body

    // Desactivar timbrados anteriores del mismo tipo
    await sql`
      UPDATE timbrados SET activo = false
      WHERE tenant_id = ${request.params.id}
        AND tipo_documento = ${body.tipoDocumento}
        AND establecimiento_id = ${body.establecimientoId}
        AND punto_id = ${body.puntoId}
    `

    const [timbrado] = await sql`
      INSERT INTO timbrados (
        tenant_id, establecimiento_id, punto_id, numero_timbrado,
        tipo_documento, numero_max, vigencia_desde, vigencia_hasta
      ) VALUES (
        ${request.params.id}, ${body.establecimientoId}, ${body.puntoId},
        ${body.numeroTimbrado}, ${body.tipoDocumento},
        ${body.numeroMax || 9999999}, ${body.vigenciaDesde}, ${body.vigenciaHasta}
      )
      RETURNING *
    `

    return reply.status(201).send({ ok: true, data: timbrado })
  })

  // ─── GET /tenants/:id/api-keys ────────────────────────────────────────────
  fastify.get('/:id/api-keys', async (request, reply) => {
    const sql = getDb()
    const keys = await sql`
      SELECT id, nombre, key_prefix, activa, ultimo_uso, creada_en, expira_en
      FROM api_keys
      WHERE tenant_id = ${request.params.id}
      ORDER BY creada_en DESC
    `
    return { ok: true, data: keys }
  })

  // ─── POST /tenants/:id/api-keys ───────────────────────────────────────────
  fastify.post('/:id/api-keys', {
    schema: {
      body: {
        type: 'object',
        required: ['nombre'],
        properties: {
          nombre:   { type: 'string' },
          ambiente: { type: 'string', enum: ['live', 'test'], default: 'live' },
        }
      }
    }
  }, async (request, reply) => {
    const sql = getDb()
    const { nombre, ambiente = 'live' } = request.body

    const { key, hash, prefix } = generarApiKey(ambiente)

    await sql`
      INSERT INTO api_keys (tenant_id, nombre, key_hash, key_prefix, key_plain)
      VALUES (${request.params.id}, ${nombre}, ${hash}, ${prefix}, ${key})
    `

    return reply.status(201).send({
      ok: true,
      data: {
        nombre,
        // Solo se muestra el key completo una vez
        key,
        prefix,
        mensaje: 'Guardá este key de forma segura, no se mostrará de nuevo'
      }
    })
  })
}
