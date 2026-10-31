import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fail, object } from './model.mjs';
const scrypt = promisify(crypto.scrypt);
export const MAX_BYTES = 16 * 1024 * 1024;
const formats = {
  'starport-profile-encrypted': 'starport-profile:1',
  'starport-pi-profile-encrypted': 'starport-pi-profile:1'
};

function passwordCheck(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) fail('password_requires_12_to_1024_characters');
}
function decode(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid_encrypted_profile');
  const b = Buffer.from(value, 'base64');
  if (b.toString('base64') !== value || (expected !== undefined && b.length !== expected)) fail('invalid_encrypted_profile');
  return b;
}
export async function encrypt(value, password) {
  passwordCheck(password);
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > MAX_BYTES) fail('profile_too_large');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await scrypt(password, salt, 32);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(formats['starport-profile-encrypted']));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { format: 'starport-profile-encrypted', version: 1, kdf: 'scrypt',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  } finally { key.fill(0); plain.fill(0); }
}
export async function decrypt(envelope, password) {
  passwordCheck(password);
  object(envelope, ['format','version','kdf','salt','iv','tag','data'], 'invalid_encrypted_profile');
  if (!Object.hasOwn(formats, envelope.format) || envelope.version !== 1 || envelope.kdf !== 'scrypt' ||
      typeof envelope.data !== 'string' || envelope.data.length > Math.ceil(MAX_BYTES / 3) * 4) fail('invalid_encrypted_profile');
  const salt = decode(envelope.salt, 16), iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16), data = decode(envelope.data);
  const key = await scrypt(password, salt, 32);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(formats[envelope.format])); decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    try { return JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
  } catch { fail('profile_password_or_integrity_failed'); }
  finally { key.fill(0); }
}
