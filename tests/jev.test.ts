import { expect, test } from 'vite-plus/test';
import { buildRequest, cacheKey, parseVerdicts, truncateSnippet } from '../src/jev.ts';
import type { JevRule, RequestMatch } from '../src/types.ts';

const secretRule: JevRule = {
  id: 'no-secret-logging',
  target: 'call',
  question: 'Does this call print, log, or send a password, token, secret, or API key?',
  cutoff: 0.8,
};
const swallowRule: JevRule = {
  id: 'no-swallowed-errors',
  target: 'function',
  question: 'Does this function swallow an error silently?',
  cutoff: 0.75,
};
const matches: RequestMatch[] = [
  { rule: secretRule, snippet: 'console.log("token", process.env.API_TOKEN)' },
  { rule: swallowRule, snippet: 'function f() { try { g() } catch {} }' },
];

test('builds the request body documented in the README', () => {
  expect(buildRequest('jev-latest', matches)).toEqual({
    model: 'jev-latest',
    state: {
      snippets: {
        s0: 'console.log("token", process.env.API_TOKEN)',
        s1: 'function f() { try { g() } catch {} }',
      },
    },
    questions: {
      s0: {
        type: 'noul',
        instructions:
          'Consider only snippet "s0" in state.snippets. Does this call print, log, or send a password, token, secret, or API key?',
      },
      s1: {
        type: 'noul',
        instructions:
          'Consider only snippet "s1" in state.snippets. Does this function swallow an error silently?',
      },
    },
  });
});

test('numbers refs in match order', () => {
  const body = buildRequest('jev-latest', [...matches, { rule: secretRule, snippet: 'third()' }]);
  expect(Object.keys(body.questions)).toEqual(['s0', 's1', 's2']);
  expect(body.state.snippets.s2).toBe('third()');
});

test('leaves a snippet at the limit untouched', () => {
  expect(truncateSnippet('abcde', 5)).toBe('abcde');
});

test('marks a snippet past the limit as truncated', () => {
  expect(truncateSnippet('abcdef', 5)).toBe('abcde/* ...truncated */');
});

const model = 'jev-1.13.0';

test('reads a verdict per ref', () => {
  const json = {
    model,
    answers: { s0: { type: 'noul', noul: 0.93 }, s1: { type: 'noul', noul: 0.12 } },
  };
  expect(parseVerdicts(json, ['s0', 's1'])).toEqual({ model, scores: { s0: 0.93, s1: 0.12 } });
});

test('ignores answers for refs that were not asked', () => {
  const json = { model, answers: { s0: { noul: 0.4 }, s9: { noul: 0.9 } } };
  expect(parseVerdicts(json, ['s0'])).toEqual({ model, scores: { s0: 0.4 } });
});

const badResponses: [string, unknown, RegExp][] = [
  ['there is no model id', { answers: { s0: { noul: 0.4 } } }, /response has no model id/],
  [
    'the model id is empty',
    { model: '', answers: { s0: { noul: 0.4 } } },
    /response has no model id/,
  ],
  ['the model id is not a string', { model: 1, answers: {} }, /response has no model id/],
  ['there is no answers object', { model }, /response has no answers object/],
  ['answers is not an object', { model, answers: 'yes' }, /response has no answers object/],
  ['answers is an array', { model, answers: [] }, /response has no answers object/],
  [
    'a ref is missing',
    { model, answers: { s0: { noul: 0.4 } } },
    /no probability in \[0, 1\] for "s1"/,
  ],
  [
    'a noul is a string',
    { model, answers: { s0: { noul: 0.4 }, s1: { noul: '0.9' } } },
    /no probability in \[0, 1\] for "s1"/,
  ],
  [
    'a noul is NaN',
    { model, answers: { s0: { noul: 0.4 }, s1: { noul: Number.NaN } } },
    /no probability in \[0, 1\] for "s1"/,
  ],
  [
    'a noul is below 0',
    { model, answers: { s0: { noul: 0.4 }, s1: { noul: -0.01 } } },
    /no probability in \[0, 1\] for "s1"/,
  ],
  [
    'a noul is above 1',
    { model, answers: { s0: { noul: 0.4 }, s1: { noul: 1.01 } } },
    /no probability in \[0, 1\] for "s1"/,
  ],
];

for (const [name, json, message] of badResponses) {
  test(`refuses a response where ${name}`, () => {
    expect(() => parseVerdicts(json, ['s0', 's1'])).toThrow(message);
  });
}

test('accepts the boundaries 0 and 1', () => {
  const json = { model, answers: { s0: { noul: 0 }, s1: { noul: 1 } } };
  expect(parseVerdicts(json, ['s0', 's1'])).toEqual({ model, scores: { s0: 0, s1: 1 } });
});

const endpoint = 'https://api.typesafe.ai';
const request = buildRequest('jev-latest', matches);
const keyInput = { endpoint, request };

test('hashes to a stable sha256 hex digest', () => {
  const key = cacheKey(keyInput);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(key).toBe(cacheKey({ endpoint, request: buildRequest('jev-latest', matches) }));
});

const keyEdits: [string, { endpoint?: string; request?: typeof request }][] = [
  ['the model changes', { request: buildRequest('jev-1', matches) }],
  [
    'a snippet changes',
    {
      request: buildRequest('jev-latest', [
        { ...matches[0], snippet: 'console.log(2)' },
        matches[1],
      ]),
    },
  ],
  [
    'a question changes',
    {
      request: buildRequest('jev-latest', [
        { ...matches[0], rule: { ...secretRule, question: 'Something else?' } },
        matches[1],
      ]),
    },
  ],
  ['two matches swap order', { request: buildRequest('jev-latest', [matches[1], matches[0]]) }],
  ['the endpoint changes', { endpoint: 'http://127.0.0.1:9' }],
];

for (const [name, edit] of keyEdits) {
  test(`invalidates the key when ${name}`, () => {
    expect(cacheKey({ ...keyInput, ...edit })).not.toBe(cacheKey(keyInput));
  });
}

test('keys on the request alone, so an edit outside every snippet reuses the entry', () => {
  const rematched = matches.map((match) => ({
    ...match,
    loc: { start: { line: 99, column: 0 }, end: { line: 99, column: 0 } },
  }));
  expect(cacheKey({ endpoint, request: buildRequest('jev-latest', rematched) })).toBe(
    cacheKey(keyInput),
  );
});

const verdictNeutralEdits: [string, JevRule][] = [
  ['a cutoff changes', { ...secretRule, cutoff: 0.81 }],
  ['a rule id changes', { ...secretRule, id: 'renamed' }],
];

for (const [name, rule] of verdictNeutralEdits) {
  test(`keeps the key when ${name}, since verdicts do not depend on it`, () => {
    const edited = buildRequest('jev-latest', [{ ...matches[0], rule }, matches[1]]);
    expect(cacheKey({ endpoint, request: edited })).toBe(cacheKey(keyInput));
  });
}
