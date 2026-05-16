// =====================================================================
// Vitest setup. Polyfills for Dexie + crypto.randomUUID under jsdom,
// silences noisy console output during tests.
// =====================================================================

import 'fake-indexeddb/auto';

if (typeof globalThis.crypto === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}
