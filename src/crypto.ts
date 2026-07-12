/**
 * Reversible encryption for secrets stored at rest (per-user provider API keys), distinct from
 * bcryptjs's one-way password hashing elsewhere in the codebase. AES-256-GCM keyed off a single
 * server-side master secret (APP_MASTER_KEY) that never touches the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

try {
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is
}

function loadMasterKey(): Buffer {
  const hex = process.env.APP_MASTER_KEY
  if (!hex) {
    throw new Error(
      "APP_MASTER_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    )
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new Error('APP_MASTER_KEY must be a 32-byte value hex-encoded to 64 characters.')
  }
  return key
}

let cachedKey: Buffer | null = null
function masterKey(): Buffer {
  if (!cachedKey) cachedKey = loadMasterKey()
  return cachedKey
}

/** Encrypts plaintext into a single "iv:authTag:ciphertext" hex-delimited string. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

/** Reverses encryptSecret. Throws if the payload is malformed or the auth tag doesn't verify. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 3) throw new Error('Malformed encrypted secret payload.')
  const [ivHex, authTagHex, ciphertextHex] = parts
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}
