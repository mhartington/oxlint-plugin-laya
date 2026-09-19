import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cacheDir = path.join(root, 'node_modules', '.cache', 'oxlint-plugin-jev');
const RULE_IDS = ['name-matches-behavior', 'no-pii-in-logs', 'no-prompt-injection'];

const skip =
  process.env.JEV_LIVE !== '1'
    ? 'set JEV_LIVE=1 to lint example/ against the real API'
    : (process.env.TYPESAFE_API_KEY ?? '').trim() === ''
      ? 'TYPESAFE_API_KEY is not set'
      : false;

test.skipIf(skip !== false)(
  'the example produces exactly the documented diagnostics against the real API',
  () => {
    rmSync(cacheDir, { recursive: true, force: true });
    const env = { ...process.env };
    delete env.CI;
    const result = spawnSync(
      path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint'),
      ['-c', 'example/.oxlintrc.json', 'example/'],
      { cwd: root, encoding: 'utf8', env },
    );
    const lines = result.stdout.split('\n').filter((line) => line.includes('jev(ask)'));
    const idsOn = (file: string) =>
      lines
        .filter((line) => line.includes(file))
        .map((line) => line.match(/\[([^\]]+)\]/)?.[1] ?? '')
        .sort();
    expect(
      idsOn('fail.js'),
      `fail.js trips each rule once\n${result.stdout}${result.stderr}`,
    ).toEqual(RULE_IDS);
    expect(idsOn('pass.js'), `pass.js is clean\n${result.stdout}${result.stderr}`).toEqual([]);
    expect(result.status, 'oxlint fails the run').toBe(1);
  },
);
