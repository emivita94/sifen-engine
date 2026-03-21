// src/config/index.js

import 'dotenv/config'

function required(name) {
  const val = process.env[name]
  if (!val) throw new Error(`Variable de entorno requerida: ${name}`)
  return val
}

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/sifen_engine',

  db: {
    poolMin: parseInt(process.env.DB_POOL_MIN || '2'),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10'),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_inseguro_cambiar',
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },

  // Clave para encriptar certificados PKCS#12 en la BD
  // Debe ser 32 bytes hex (64 chars)
  certEncryptionKey: process.env.CERT_ENCRYPTION_KEY || 'dev_key_32bytes_insegura_cambiar_en_prod00',

  sifen: {
    ambiente: process.env.SIFEN_AMBIENTE || 'test',
    timeoutMs: parseInt(process.env.SIFEN_TIMEOUT_MS || '30000'),
    // URLs de SIFEN por ambiente
    urls: {
      test: {
        recepcion: 'https://sifen-test.set.gov.py/de/ws/sync/recibe-lote',
        consulta:  'https://sifen-test.set.gov.py/de/ws/consultas/consulta',
        evento:    'https://sifen-test.set.gov.py/de/ws/eventos/recibe-evento',
      },
      prod: {
        recepcion: 'https://sifen.set.gov.py/de/ws/sync/recibe-lote',
        consulta:  'https://sifen.set.gov.py/de/ws/consultas/consulta',
        evento:    'https://sifen.set.gov.py/de/ws/eventos/recibe-evento',
      }
    }
  },

  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  }
}
