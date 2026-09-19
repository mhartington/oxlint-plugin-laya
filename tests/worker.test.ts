import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { buildRequest } from '../src/jev.ts';
import type { AskInput, AskResult } from '../src/types.ts';
import { startMockJev, type MockJev } from './mock-jev.ts';

// `src/sync-jev.ts` resolves its worker as `./worker.mjs` next to itself, which only exists in
// `dist`, so this drives the built copy. The specifier is a variable so a typecheck before the
// first build still resolves, and the signature comes from the source it was built from.
const dist: unknown = await import(new URL('../dist/sync-jev.mjs', import.meta.url).href);
const { askJev } = dist as { askJev: (input: AskInput) => AskResult };

const request = buildRequest('jev-latest', [{ rule: { question: 'Is it bad?' }, snippet: 'f()' }]);

let mock: MockJev;
beforeAll(async () => {
  mock = await startMockJev();
});
afterAll(() => mock.child.kill());

const ask = (apiKey: string, extra: Partial<AskInput> = {}): AskResult =>
  askJev({ apiKey, baseURL: mock.baseURL, request, timeoutMs: 5000, ...extra });
const hits = (token: string) =>
  readFileSync(mock.logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`"Bearer ${token}"`)).length;

test('returns the parsed body on 2xx', () => {
  const result = ask('test-key');
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  expect(result.ok ? result.json : null).toMatchObject({
    answers: { s0: { type: 'noul', noul: 0.05 } },
  });
});

test('maps a non-2xx status to an http reason without repeating the status', () => {
  const result = ask('unauthorized');
  expect(result.ok).toBe(false);
  const reason = result.ok ? '' : result.reason;
  expect(reason).toMatch(/^http 401: /);
  expect(reason).not.toMatch(/^http 401: 401/);
  expect(hits('unauthorized'), 'a 401 is not retried').toBe(1);
});

test('retries a 429 through the SDK and returns the eventual answer', () => {
  expect(ask('flaky').ok).toBe(true);
  expect(hits('flaky'), 'the first attempt got the 429 and the second the answer').toBe(2);
});

test('maps a stalled response to timeout within the per-file budget', () => {
  const started = Date.now();
  expect(ask('slow', { timeoutMs: 300 })).toEqual({ ok: false, reason: 'timeout' });
  expect(Date.now() - started, 'retries do not extend the wait past our signal').toBeLessThan(2000);
});

test('maps a refused connection to a network reason', () => {
  const result = askJev({
    apiKey: 'test-key',
    baseURL: 'http://127.0.0.1:9',
    request,
    timeoutMs: 5000,
  });
  expect(result.ok).toBe(false);
  expect(result.ok ? '' : result.reason).toMatch(/^network: /);
});
