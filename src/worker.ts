import { APIError, APITimeoutError, APIUserAbortError, TypeSafeClient } from '@typesafe-ai/sdk';
import { runAsWorker } from 'synckit';
import { messageOf } from './jev.ts';
import type { AskInput, AskResult } from './types.ts';

let cached: { key: string; client: TypeSafeClient } | null = null;

function clientWith(apiKey: string, baseURL: string): TypeSafeClient {
  const key = JSON.stringify([apiKey, baseURL]);
  if (cached === null || cached.key !== key) {
    cached = { key, client: new TypeSafeClient({ apiKey, baseURL }) };
  }
  return cached.client;
}

// The SDK's own message already leads with the status code.
const withoutStatus = (error: APIError): string =>
  error.message.replace(new RegExp(`^${error.status} `), '');

function reasonFor(error: unknown): string {
  if (error instanceof APIUserAbortError || error instanceof APITimeoutError) return 'timeout';
  if (error instanceof APIError) return `http ${error.status}: ${withoutStatus(error)}`;
  return `network: ${messageOf(error)}`;
}

runAsWorker(async ({ apiKey, baseURL, request, timeoutMs }: AskInput): Promise<AskResult> => {
  try {
    const json = await clientWith(apiKey, baseURL).systemOne(request, {
      signal: AbortSignal.timeout(timeoutMs),
      timeout: timeoutMs,
    });
    return { ok: true, json };
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }
});
