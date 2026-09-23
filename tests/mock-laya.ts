import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export interface MockLaya {
  child: ChildProcessByStdio<null, Readable, null>;
  logPath: string;
  baseURL: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// The mock lives in its own process because the rule blocks the calling thread while it waits,
// and a server on that thread could never answer.
export function startMockLaya(
  logPath = path.join(mkdtempSync(path.join(tmpdir(), 'laya-mock-')), 'requests.jsonl'),
): Promise<MockLaya> {
  const child = spawn(process.execPath, [path.join(here, 'laya-mock-server.ts'), logPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk: Buffer) => {
      const port = Number(String(chunk).trim().slice(5));
      resolve({ child, logPath, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}
