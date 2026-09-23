import { setTimeout as delay } from 'node:timers/promises';
import { runAsWorker } from 'synckit';
import { messageOf } from './laya.ts';
import type { AskInput, AskResult } from './types.ts';

const MAX_RETRIES = 2;

function retryDelay(headers: Headers, attempt: number): number {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) {
    return Number(milliseconds);
  }
  const after = headers.get('retry-after');
  if (after !== null) {
    const ms = Number.isFinite(Number(after))
      ? Number(after) * 1000
      : Date.parse(after) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return 250 * 2 ** attempt;
}

runAsWorker(async ({ apiKey, baseURL, request, timeoutMs }: AskInput): Promise<AskResult> => {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${baseURL.replace(/\/+$/, '')}/v1/systemone`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal,
      });
      const body = await response.text();
      if (response.ok) {
        try {
          return { ok: true, json: JSON.parse(body) as unknown };
        } catch {
          return { ok: false, reason: 'response is not valid JSON' };
        }
      }
      if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
        // The same signal bounds requests, response bodies, and retry waits together.
        await delay(Math.min(retryDelay(response.headers, attempt), timeoutMs), undefined, {
          signal,
        });
        continue;
      }
      return { ok: false, reason: `http ${response.status}: ${body || response.statusText}` };
    }
  } catch (error) {
    return { ok: false, reason: signal.aborted ? 'timeout' : `network: ${messageOf(error)}` };
  }
});
