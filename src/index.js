// src/index.js
// Entry point del motor SIFEN

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config } from './config/index.js'
import { authPlugin } from './shared/auth/plugin.js'
import { documentosRoutes } from './modules/documentos/routes.js'
import { tenantsRoutes } from './modules/tenants/routes.js'
import { tenantHealthRoute } from './modules/tenants/health.js'
import { getDb, closeDb } from './db/connection.js'

const fastify = Fastify({
  logger: {
    level: config.log.level,
    transport: config.isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  },
  bodyLimit: 1048576,
})

// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: [
    'https://nodoengineweb.pages.dev',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
  credentials: true,
})

// ── Rate limiting global ──────────────────────────────────────────────────────
await fastify.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
  keyGenerator: (request) => request.tenant?.id || request.ip,
  addHeaders: {
    'x-ratelimit-limit':     true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset':     true,
    'retry-after':           true,
  },
  errorResponseBuilder: () => ({
    error: 'Rate limit excedido',
    mensaje: `Máximo ${config.rateLimit.max} requests por minuto`
  })
})

// ── Ruta pública health ───────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  ok: true,
  version: '0.1.0',
  ambiente: config.sifen.ambiente,
  timestamp: new Date().toISOString(),
}))

// ── Tenants (público — sin auth) ──────────────────────────────────────────────
await fastify.register(tenantsRoutes, { prefix: '/api/v1/tenants' })

// ── Rutas protegidas con auth ─────────────────────────────────────────────────
// Registramos auth + rutas protegidas en un scope encapsulado
await fastify.register(async (protectedApp) => {
  // Auth hook aplica a todo este scope
  await protectedApp.register(authPlugin)

  // Rutas que requieren autenticación
  await protectedApp.register(tenantHealthRoute, { prefix: '/api/v1/tenants' })
  await protectedApp.register(documentosRoutes, { prefix: '/api/v1/documentos' })
})

// ── Manejo de errores global ──────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error)
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
    fastify.log.info(`DATABASE_URL cargada: ${process.env.DATABASE_URL ? 'SÍ ✓' : 'NO ✗'}`)
    fastify.log.info(`Conectando a: ${config.databaseUrl.split('@')[1]}`)

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

const shutdown = async (signal) => {
  fastify.log.info(`Señal ${signal} recibida, cerrando...`)
  await fastify.close()
  await closeDb()
  process.exit(0)
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
