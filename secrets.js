// =====================================================
// Encryption for stored secrets (clients' CRM API keys)
//
// AES-256-GCM. The key comes from CRM_ENCRYPTION_KEY (any long random
// string), or is derived from API_SECRET_KEY so it works without extra setup.
// Stored format: v1.<iv>.<tag>.<ciphertext>  (base64url parts)
// =====================================================

const crypto = require('crypto');

function deriveKey(env = process.env) {
  const material = env.CRM_ENCRYPTION_KEY || (env.API_SECRET_KEY ? `${env.API_SECRET_KEY}:crm-keys` : null);
  if (!material) return null;
  return crypto.createHash('sha256').update(material).digest();
}

function createSecretBox(key) {
  if (!key || key.length !== 32) throw new Error('Encryption key not configured');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
    },
    decrypt(stored) {
      const [v, iv, tag, ct] = String(stored).split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognized secret format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

// Last 4 characters, for showing which key is connected without revealing it.
const keyHint = (k) => (k && k.length > 8 ? `…${k.slice(-4)}` : '…');

module.exports = { deriveKey, createSecretBox, keyHint };
