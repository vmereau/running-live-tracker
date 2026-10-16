// AD-5: the single definition of how a runner key becomes its configured keyHash.
import { createHash } from 'node:crypto';

/** Lowercase hex SHA-256 of the key's UTF-8 bytes (64 chars). */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
