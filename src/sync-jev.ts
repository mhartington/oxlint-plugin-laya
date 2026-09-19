import { fileURLToPath } from 'node:url';
import { createSyncFn, type Syncify } from 'synckit';
import { messageOf } from './jev.ts';
import type { AskInput, AskResult } from './types.ts';

// synckit fixes its timeout when the sync fn is created, but ours is per call, so the
// worker owns the real deadline via AbortSignal.timeout and this is only a backstop.
const BACKSTOP_MS = 60000;
const SYNCKIT_TIMEOUT = 'Internal error: Atomics.wait() failed: timed-out';

type JevWorker = (input: AskInput) => Promise<AskResult>;

let call: Syncify<JevWorker> | null = null;

function jevCall(): Syncify<JevWorker> {
  call ??= createSyncFn<JevWorker>(fileURLToPath(new URL('./worker.mjs', import.meta.url)), {
    timeout: BACKSTOP_MS,
  });
  return call;
}

export function askJev(input: AskInput): AskResult {
  try {
    return jevCall()(input);
  } catch (error) {
    const message = messageOf(error);
    if (message === SYNCKIT_TIMEOUT) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: `network: ${message}` };
  }
}
