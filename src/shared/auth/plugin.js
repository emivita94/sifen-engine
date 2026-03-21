// src/shared/auth/plugin.js
// Plugin Fastify de autenticación
// Verifica el API key del header X-API-Key o Authorization: Bearer sk_...
// Inyecta request.tenant con los datos del tenant autenticado

import { hashApiKey } from '../crypto/index.js'
import { getDb } from '../../db/connection.js'

export async function authPlugin(fastify) {
  fastify.decorate('authenticate', authenticate)

  // Hook preHandler: verifica auth en todas las rutas que lo pidan
  fastify.addHook('preHandler', async (request, reply) => {
    // Rutas públicas que no requieren autenticación
    const PUBLICAS = [
      '/health',
      '/docs',
      '/tenants',          // crear tenant es público (proteger con secret de admin en prod)
    ]

    // Si la ruta empieza con alguna pública, skip
    if (PUBLICAS.some(p => request.url === p || request.url.startsWith(p + '?'))) {
      return
    }

    await authenticate(request, reply)
  })
}

async function authenticate(request, reply) {
  const sql = getDb()

  // Extraer el API key del header
  const authHeader = request.headers['authorization'] || request.headers['x-api-key']
  if (!authHeader) {
    return reply.status(401).send({
      error: 'Sin autenticación',
      mensaje: 'Incluí tu API key en el header X-API-Key o Authorization: Bearer sk_...'
    })
  }

  // Soporta tanto "Bearer sk_live_xxx" como directamente "sk_live_xxx"
  const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

  if (!key.startsWith('sk_')) {
    return reply.status(401).send({
      error: 'Formato de API key inválido',
      mensaje: 'El key debe comenzar con sk_live_ o sk_test_'
    })
  }

  // Hashear el key y buscar en BD
  const hash = hashApiKey(key)

  const [apiKey] = await sql`
    SELECT ak.id, ak.tenant_id, ak.activa, ak.expira_en,
           t.id as tid, t.nombre, t.ruc, t.razon_social,
           t.ambiente, t.activo as tenant_activo,
           t.certificado_enc, t.cert_alias, t.codigo_seguridad
    FROM api_keys ak
    JOIN tenants t ON t.id = ak.tenant_id
    WHERE ak.key_hash = ${hash}
  `

  if (!apiKey) {
    return reply.status(401).send({ error: 'API key inválido' })
  }

  if (!apiKey.activa) {
    return reply.status(401).send({ error: 'API key desactivado' })
  }

  if (apiKey.expiraEn && new Date(apiKey.expiraEn) < new Date()) {
    return reply.status(401).send({ error: 'API key vencido' })
  }

  if (!apiKey.tenantActivo) {
    return reply.status(403).send({ error: 'Tenant inactivo. Contactá al soporte.' })
  }

  // Inyectar tenant en el request para que los handlers lo usen
  request.tenant = {
    id:               apiKey.tid,
    nombre:           apiKey.nombre,
    ruc:              apiKey.ruc,
    razonSocial:      apiKey.razonSocial,
    ambiente:         apiKey.ambiente,
    certificadoEnc:   apiKey.certificadoEnc,
    certAlias:        apiKey.certAlias,
    codigoSeguridad:  apiKey.codigoSeguridad,
  }

  // Actualizar último uso (sin await para no bloquear el request)
  sql`UPDATE api_keys SET ultimo_uso = now() WHERE id = ${apiKey.id}`.catch(() => {})
}
