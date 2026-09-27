import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const hex = process.env.ENCRYPTION_KEY;
// Checked before decoding, because Buffer.from(hex, "hex") stops at the first
// non-hex character instead of throwing, leaving a short key.
if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
  throw new Error(
    `ENCRYPTION_KEY must be 32 bytes as 64 hex characters. Generate one with:
  node -e "console.log(crypto.randomBytes(32).toString('hex'))"`,
  );
}
const key = Buffer.from(hex, "hex");

// GCM's standard IV size. An IV must never repeat under the same key, so each
// encryption gets a new random one.
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM, returned as base64 of IV + auth tag + ciphertext. The user's id
 * is authenticated along with it but not stored in it: copied into another
 * user's row, the value no longer decrypts.
 */
export function encrypt(plaintext: string, userId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Throws if `stored` was altered, or encrypted with another key or for another user. */
export function decrypt(stored: string, userId: string): string {
  const data = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES), {
    // Otherwise Node accepts a tag as short as 4 bytes, which is easier to forge.
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plaintext = Buffer.concat([
    decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
