// src/shared/crypto/index.js
// Encriptación AES-256-GCM para certificados PKCS#12
// Hashing de API keys con SHA-256

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import { config } from '../../config/index.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12    // 96 bits para GCM
const TAG_LENGTH = 16   // 128 bits auth tag

/**
 * Encripta datos (buffer o string) con AES-256-GCM
 * Retorna base64: iv(12) + tag(16) + ciphertext
 */
export function encriptar(data) {
  const key = Buffer.from(config.certEncryptionKey, 'hex')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()])
  const tag = cipher.getAuthTag()

  // Empaqueta: iv | tag | ciphertext
  const result = Buffer.concat([iv, tag, encrypted])
  return result.toString('base64')
}

/**
 * Desencripta datos encriptados con encriptar()
 * Retorna Buffer
 */
export function desencriptar(base64) {
  const key = Buffer.from(config.certEncryptionKey, 'hex')
  const data = Buffer.from(base64, 'base64')

  const iv         = data.subarray(0, IV_LENGTH)
  const tag        = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Genera un API key seguro y retorna:
 * { key: 'sk_live_xxx...', hash: 'sha256hex', prefix: 'sk_live_xxxx' }
 */
export function generarApiKey(ambiente = 'live') {
  const random = randomBytes(32).toString('base64url')
  const key = `sk_${ambiente}_${random}`
  const hash = hashApiKey(key)
  console.log('KEY RECIBIDO:', key)
console.log('HASH GENERADO:', hash)
console.log('HASH EN BD:   fd9391f9d04741a8ce9345581f1e683845b1d8a4515878f0fbd9cf4990100b37')
  const prefix = key.substring(0, 16)

  return { key, hash, prefix }
}

/**
 * Hash SHA-256 de un API key para almacenar en BD
 */
export function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex')
}
