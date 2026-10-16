// Runner identity from a presented key (AD-5). Lives in config because ingest
// may not import domain, and config -> domain is allowed.
import { timingSafeEqual } from 'node:crypto';
import { hashKey } from '../domain/hash-key.ts';
import type { EventConfig } from './load-config.ts';

/** Returns the runnerId owning the key, or undefined. Never throws. */
export type KeyLookup = (key: string) => string | undefined;

export function createKeyLookup(config: EventConfig): KeyLookup {
  // keyHash is validated as 64 lowercase hex chars, so every buffer is 32 bytes.
  const entries = config.runners.map((r) => ({ runnerId: r.runnerId, hash: Buffer.from(r.keyHash, 'hex') }));
  return (key) => {
    // Always hash, whatever the input, then compare against every runner with no early exit,
    // so timing does not reveal which runner (if any) a key belongs to.
    const presented = Buffer.from(hashKey(typeof key === 'string' ? key : ''), 'hex');
    let match: string | undefined;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.hash) && match === undefined) match = entry.runnerId;
    }
    // An empty key is never valid, even if some config held the hash of "".
    return key === '' || typeof key !== 'string' ? undefined : match;
  };
}
