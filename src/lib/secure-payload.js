import crypto from 'node:crypto';

const PAYLOAD_VERSION = 'v1';

function encryptionKey() {
  // ENCRYPTION_KEY remains a temporary migration fallback for existing stores.
  // Production must use a distinct DATA_ENCRYPTION_KEY and SESSION_SECRET.
  const raw = process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || 'development-only-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptPayload(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PAYLOAD_VERSION}.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptPayload(payload) {
  const [version, ivB64, tagB64, dataB64] = String(payload || '').split('.');
  if (version !== PAYLOAD_VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error('Unsupported encrypted payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function isEncryptedPayload(value) {
  return typeof value === 'string' && value.startsWith(`${PAYLOAD_VERSION}.`);
}
