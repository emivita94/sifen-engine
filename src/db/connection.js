// src/db/connection.js
// Pool de conexiones PostgreSQL usando la librería `postgres`

import postgres from 'postgres'
import { config } from '../config/index.js'

let sql

export function getDb() {
  if (!sql) {
    sql = postgres(config.databaseUrl, {
      max: config.db.poolMax,
      idle_timeout: 30,
      connect_timeout: 10,
      ssl: { rejectUnauthorized: false },
      transform: {
        column: postgres.toCamel,
      },
      onnotice: () => {},
    })
  }
  return sql
}

export async function closeDb() {
  if (sql) {
    await sql.end()
    sql = null
  }
}
