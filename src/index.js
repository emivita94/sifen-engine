// src/index.js
// Entry point del motor SIFEN
// Levanta el servidor Fastify con todos los plugins y rutas

import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { config } from './config/index.js'
import { authPlugin } from './shared/auth/plugin.js'
import { documentosRoutes } from './modules/documentos/routes.js'
import { tenantsRoutes } from './modules/tenants/routes.js'
import { getDb, closeDb } from './db/connection.js'

// ── Crear instancia de Fastify ────────────────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: config.log.level,
    transport: config.isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  },
  // Parsea body JSON automáticamente
  bodyLimit: 1048576, // 1MB
})

// ── Plugins ───────────────────────────────────────────────────────────────────

// Rate limiting global
await fastify.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
  keyGenerator: (request) =>
    // Limitar por tenant si está autenticado, sino por IP
    request.tenant?.id || request.ip,
  errorResponseBuilder: () => ({
    error: 'Rate limit excedido',
    mensaje: `Máximo ${config.rateLimit.max} requests por minuto`
  })
})

// Auth middleware
await fastify.register(authPlugin)

// ── Rutas ─────────────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  ok: true,
  version: '0.1.0',
  ambiente: config.sifen.ambiente,
  timestamp: new Date().toISOString(),
}))

// Documentos electrónicos (requiere auth)
await fastify.register(documentosRoutes, { prefix: '/api/v1/documentos' })

// Gestión de tenants (proteger con admin token en producción)
await fastify.register(tenantsRoutes, { prefix: '/api/v1/tenants' })

// ── Manejo de errores global ───────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error)

  // Errores de validación de Fastify
  if (error.validation) {
    return reply.status(400).send({
      error: 'Datos inválidos',
      detalles: error.validation,
    })
  }

  return reply.status(error.statusCode || 500).send({
    error: error.message || 'Error interno del servidor',
  })
})

// ── Arranque ──────────────────────────────────────────────────────────────────
async function start() {
  try {

     // ⚠️ AGREGADO: log de diagnóstico para verificar variables en Railway
    fastify.log.info(`DATABASE_URL cargada: ${process.env.DATABASE_URL ? 'SÍ ✓' : 'NO ✗ — FALTA LA VARIABLE'}`)
    fastify.log.info(`Conectando a: ${config.databaseUrl.split('@')[1]}`) // muestra host sin password


    // Verificar conexión a BD
    const sql = getDb()
    await sql`SELECT 1`
    fastify.log.info('✓ Conexión a PostgreSQL OK')

    await fastify.listen({ port: config.port, host: '0.0.0.0' })
    fastify.log.info(`✓ Servidor escuchando en puerto ${config.port}`)
    fastify.log.info(`✓ Ambiente SIFEN: ${config.sifen.ambiente}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }


}

// ── Shutdown graceful ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  fastify.log.info(`Señal ${signal} recibida, cerrando...`)
  await fastify.close()
  await closeDb()
  process.exit(0)
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
