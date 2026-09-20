import { appendFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';

interface MockRequestBody {
  questions: Record<string, { instructions: string }>;
  state: { snippets: Record<string, string> };
}

const logPath = process.argv[2] ?? '';
const MARKER_BY_QUESTION: Record<string, string> = {
  'personal data': 'user.email, user.phone',
  'only reads data': 'loaded',
  'language model': '${message}',
};

function scoreFor(question: string, snippet: string): number {
  const topic = Object.keys(MARKER_BY_QUESTION).find((key) => question.includes(key));
  return topic !== undefined && snippet.includes(MARKER_BY_QUESTION[topic]) ? 0.95 : 0.05;
}

function answer(body: MockRequestBody) {
  const answers: Record<string, { type: 'noul'; noul: number }> = {};
  for (const ref of Object.keys(body.questions)) {
    answers[ref] = {
      type: 'noul',
      noul: scoreFor(body.questions[ref].instructions, body.state.snippets[ref]),
    };
  }
  return { model: 'jev-mock', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

const hitsByToken: Record<string, number> = {};

// The bearer token picks a failure mode, so one server covers the worker's error mapping too.
function reply(token: string, body: MockRequestBody, response: ServerResponse): void {
  hitsByToken[token] = (hitsByToken[token] ?? 0) + 1;
  if (token === 'slow') return;
  if (token === 'unauthorized') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  if (token === 'flaky' && hitsByToken[token] === 1) {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '10' });
    response.end('{}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer(body)));
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (request.method !== 'POST' || request.url !== '/v1/systemone') {
      response.writeHead(404).end('{}');
      return;
    }
    const body = JSON.parse(raw) as MockRequestBody;
    appendFileSync(
      logPath,
      `${JSON.stringify({ authorization: request.headers.authorization, body })}\n`,
    );
    reply((request.headers.authorization ?? '').replace('Bearer ', ''), body, response);
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the mock server did not bind a port');
  }
  process.stdout.write(`PORT=${address.port}\n`);
});
