import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vite-plus/test';
import type { LayaRule } from '../src/types.ts';
import { startMockLaya } from './mock-laya.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const cacheDir = path.join(root, 'node_modules', '.cache', 'oxlint-plugin-laya');
const RULE_IDS = ['no-pii-in-logs', 'name-matches-behavior', 'no-prompt-injection'];
const pluginPath = path.join(root, 'dist', 'index.mjs');
// vite-plus ships its own LSP-only `oxlint` bin, which shadows the real one in node_modules/.bin.
const oxlintBin = path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');

interface LoggedRequest {
  authorization?: string;
  body: {
    model: string;
    state: { snippets: Record<string, string> };
    questions: Record<string, { instructions: string }>;
  };
}

interface OxlintSpan {
  line: number;
  column: number;
  length: number;
}

interface OxlintReport {
  diagnostics: { code: string; labels: { span: OxlintSpan }[] }[];
}

// oxlint picks its reporter from the environment, and on Actions runners that is GitHub
// annotations, so the format is named explicitly.
function runOxlint(env: Record<string, string>, format: 'unix' | 'json' | 'default' = 'unix') {
  const clean = { ...process.env };
  delete clean.CI;
  delete clean.LAYA_API_KEY;
  delete clean.LAYA_BASE_URL;
  return spawnSync(oxlintBin, ['--format', format, '-c', 'example/.oxlintrc.json', 'example/'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
}

const layaLines = (result: SpawnSyncReturns<string>) =>
  result.stdout.split('\n').filter((line) => line.includes('laya(ask)'));

const asked = (logPath: string): LoggedRequest[] =>
  readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest);

test('oxlint reports what Laya answered yes to', async () => {
  const { child, logPath, baseURL } = await startMockLaya();
  onTestFinished(() => {
    child.kill();
  });
  const withLaya = { LAYA_API_KEY: 'test-key', LAYA_BASE_URL: baseURL };

  rmSync(cacheDir, { recursive: true, force: true });
  const first = runOxlint(withLaya);

  expect(first.status, `oxlint fails the run\n${first.stdout}${first.stderr}`).toBe(1);
  for (const id of RULE_IDS) {
    expect(first.stdout.includes(`[${id}]`), `${id} is reported\n${first.stdout}`).toBe(true);
  }
  expect(
    layaLines(first),
    `the messageId renders the id, the model that answered, both numbers at two decimals, and the question\n${first.stdout}`,
  ).toContain(
    'example/fail.js:5:3: [no-pii-in-logs] laya-mock answered yes (0.95 >= 0.80): Does this call write personal data, such as an email or phone number, to a log or console? [Error/laya(ask)]',
  );
  expect(
    layaLines(first).length,
    'every reported rule has its own diagnostic',
  ).toBeGreaterThanOrEqual(RULE_IDS.length);
  for (const line of layaLines(first)) {
    expect(line, 'Laya diagnostics only land on fail.js').toMatch(/example\/fail\.js/);
  }
  expect(
    layaLines(first).filter((line) => line.includes('pass.js')).length,
    'pass.js is clean',
  ).toBe(0);

  const requests = asked(logPath);
  expect(requests.length, 'one request per linted file').toBe(2);
  for (const request of requests) {
    expect(request.authorization, 'the API key is sent as a bearer token').toBe('Bearer test-key');
  }
  const snippetsOf = (request: LoggedRequest) => Object.values(request.body.state.snippets);
  const forFail = requests.find((request) => snippetsOf(request).some((s) => s.includes('loaded')));
  const forPass = requests.find((request) => request !== forFail);
  expect(forFail, 'fail.js was asked about').toBeDefined();
  expect(forPass, 'pass.js was asked about').toBeDefined();
  expect(
    Object.keys(forFail?.body.questions ?? {}).length,
    'fail.js asks about at least 3 snippets',
  ).toBeGreaterThanOrEqual(3);
  expect(
    Object.keys(forPass?.body.questions ?? {}).length,
    'pass.js asks about at least 1 snippet',
  ).toBeGreaterThanOrEqual(1);
  expect(forFail?.body.model, 'the configured hosted model is sent').toBe('convaiinnovations/laya');

  const second = runOxlint(withLaya);
  expect(asked(logPath).length, 'a cached file is not asked about again').toBe(2);
  expect(second.status, 'a cached run still fails').toBe(1);
  expect(layaLines(second), 'a cached run reports the same diagnostics').toEqual(layaLines(first));

  for (const entry of readdirSync(cacheDir)) writeFileSync(path.join(cacheDir, entry), '{}');
  const third = runOxlint(withLaya);
  expect(
    asked(logPath).length,
    'a malformed cache entry is a miss, so both files are asked about again',
  ).toBe(4);
  expect(
    layaLines(third),
    'a run over malformed cache entries reports the same diagnostics',
  ).toEqual(layaLines(first));

  const report = JSON.parse(runOxlint(withLaya, 'json').stdout) as OxlintReport;
  const spans = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'laya(ask)')
    .map((diagnostic) => diagnostic.labels[0].span);
  const failLines = readFileSync(path.join(root, 'example', 'fail.js'), 'utf8').split('\n');
  const spanAt = (line: number): OxlintSpan => {
    const span = spans.find((candidate) => candidate.line === line);
    if (span === undefined) throw new Error(`no laya diagnostic on line ${line}`);
    return span;
  };
  expect(spanAt(3).length, 'a function hit underlines only its signature line').toBe(
    failLines[2].length - spanAt(3).column + 1,
  );
  expect(spanAt(5).length, 'a call hit underlines the whole call').toBe(
    'console.log("loaded", user.email, user.phone)'.length,
  );
});

test('an unavailable server fails the run under CI when ci is fail', () => {
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint({ CI: '1', LAYA_BASE_URL: 'http://127.0.0.1:9' }, 'default');
  expect(result.status, 'oxlint fails the run').not.toBe(0);
  expect(`${result.stdout}${result.stderr}`, 'the connection failure is reported').toMatch(
    /network:/,
  );
});

test('an unavailable server outside CI warns and skips', () => {
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint({ LAYA_BASE_URL: 'http://127.0.0.1:9' });
  expect(result.status, `oxlint passes the run\n${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stderr, 'the connection failure is named on stderr').toMatch(/network:/);
  expect(layaLines(result), 'nothing is reported without a response').toEqual([]);
});

test('a local server is used without an API key, including in CI', async () => {
  const { child, logPath, baseURL } = await startMockLaya();
  onTestFinished(() => {
    child.kill();
  });
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint({ CI: '1', LAYA_BASE_URL: `  ${baseURL}///  ` });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
  expect(layaLines(result).length).toBeGreaterThanOrEqual(RULE_IDS.length);
  const requests = asked(logPath);
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request.authorization).toBeUndefined();
});

test('an authenticated server rejects a bad key under CI', async () => {
  const { child, baseURL } = await startMockLaya();
  onTestFinished(() => {
    child.kill();
  });
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint(
    { CI: '1', LAYA_BASE_URL: baseURL, LAYA_API_KEY: 'unauthorized' },
    'default',
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain('http 401:');
});

test('two files with the same text but different parses are asked about separately', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'laya-twins-'));
  const { child, logPath, baseURL } = await startMockLaya();
  onTestFinished(() => {
    child.kill();
  });
  const callRule: LayaRule = {
    id: 'any-call',
    target: 'call',
    question: 'Is this call bad?',
    cutoff: 0.8,
  };
  writeFileSync(
    path.join(project, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'laya/ask': ['error', { rules: [callRule] }] },
    }),
  );
  const text = 'first();\nf<T>(x);\nlast();\n';
  writeFileSync(path.join(project, 'same.js'), text);
  writeFileSync(path.join(project, 'same.ts'), text);

  const clean = { ...process.env };
  delete clean.CI;
  const result = spawnSync(oxlintBin, ['-c', '.oxlintrc.json', 'same.js', 'same.ts'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...clean, LAYA_API_KEY: 'test-key', LAYA_BASE_URL: baseURL },
  });
  expect(result.status, `oxlint runs both files\n${result.stdout}${result.stderr}`).toBe(0);
  const counts = asked(logPath)
    .map((request) => Object.keys(request.body.questions).length)
    .sort((a, b) => a - b);
  expect(
    counts,
    'the .js parse sees two calls and the .ts parse sees three, so each file gets its own request',
  ).toEqual([2, 3]);
});

test('a file over maxMatchesPerFile is capped and named on stderr', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'laya-capped-'));
  const { child, logPath, baseURL } = await startMockLaya();
  onTestFinished(() => {
    child.kill();
  });
  const piiRule: LayaRule = {
    id: 'no-pii-in-logs',
    target: 'call',
    question: 'Does this call write personal data to a log?',
    cutoff: 0.8,
  };
  writeFileSync(
    path.join(project, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'laya/ask': ['error', { maxMatchesPerFile: 25, rules: [piiRule] }] },
    }),
  );
  writeFileSync(
    path.join(project, 'rows.js'),
    `${Array.from({ length: 30 }, () => 'console.log("row", user.email, user.phone);').join('\n')}\n`,
  );

  const clean = { ...process.env };
  delete clean.CI;
  const result = spawnSync(oxlintBin, ['--format', 'unix', '-c', '.oxlintrc.json', 'rows.js'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...clean, LAYA_API_KEY: 'test-key', LAYA_BASE_URL: baseURL },
  });
  const requests = asked(logPath);
  expect(requests.length, 'the file is asked about once').toBe(1);
  expect(Object.keys(requests[0].body.questions).length, 'only the first 25 matches are sent').toBe(
    25,
  );
  expect(result.stderr, `the dropped tail is counted on stderr\n${result.stderr}`).toContain(
    '30 matches exceeded maxMatchesPerFile=25, 5 not checked',
  );
  expect(result.stderr, 'the capped file is named on stderr').toContain('rows.js');
  expect(layaLines(result).length, 'the 25 sent matches are still reported').toBe(25);
  expect(result.status, 'the cap does not change the exit code').toBe(1);
});

function runWithOptions(options: unknown) {
  const config = path.join(mkdtempSync(path.join(tmpdir(), 'laya-config-')), '.oxlintrc.json');
  writeFileSync(
    config,
    JSON.stringify({ jsPlugins: [pluginPath], rules: { 'laya/ask': ['error', options] } }),
  );
  const clean = { ...process.env };
  delete clean.CI;
  delete clean.LAYA_API_KEY;
  return spawnSync(oxlintBin, ['--format', 'default', '-c', config, 'example/pass.js'], {
    cwd: root,
    encoding: 'utf8',
    env: clean,
  });
}

const goodRule: LayaRule = { id: 'a', target: 'call', question: 'Is it bad?', cutoff: 0.8 };

const badConfigs: [string, unknown, string][] = [
  [
    'a target is not one the plugin knows',
    { rules: [{ ...goodRule, target: 'class' }] },
    'Value "class" should be equal to one of the allowed values.',
  ],
  [
    'a plugin-level field is unknown',
    { foo: 1, rules: [goodRule] },
    'Unexpected property "foo". Expected properties: "ci", "timeoutMs", "maxMatchesPerFile", "maxSnippetChars", "model", "rules".',
  ],
  [
    'two rules share an id',
    { rules: [goodRule, { ...goodRule, target: 'file', question: 'Other?' }] },
    'oxlint-plugin-laya: rule id "a" is used more than once',
  ],
];

for (const [name, options, expected] of badConfigs) {
  test(`oxlint refuses a config where ${name}`, () => {
    const result = runWithOptions(options);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, `oxlint fails the run\n${output}`).not.toBe(0);
    expect(output.includes(expected), `the error names the problem\n${output}`).toBe(true);
  });
}
