import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseVerdicts } from './laya.ts';
import type { Verdicts } from './types.ts';

export const defaultCacheDir = (): string =>
  path.join(process.cwd(), 'node_modules', '.cache', 'oxlint-plugin-laya');

export function readCache(dir: string, key: string, refs: readonly string[]): Verdicts | null {
  try {
    const stored: unknown = JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    return parseVerdicts(stored, refs);
  } catch {
    return null;
  }
}

export function writeCache(dir: string, key: string, response: unknown): void {
  const target = path.join(dir, `${key}.json`);
  const temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, JSON.stringify(response));
  renameSync(temp, target);
}
