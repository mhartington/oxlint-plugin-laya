import { createHash } from 'node:crypto';
import type { NoulQuestion } from '@typesafe-ai/sdk';
import type { JevRequest, RequestMatch, Verdicts } from './types.ts';

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const refAt = (index: number): string => `s${index}`;

export function truncateSnippet(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}/* ...truncated */`;
}

export function buildRequest(model: string, matches: readonly RequestMatch[]): JevRequest {
  const snippets: Record<string, string> = {};
  const questions: Record<string, NoulQuestion> = {};
  matches.forEach((match, index) => {
    const ref = refAt(index);
    snippets[ref] = match.snippet;
    questions[ref] = {
      type: 'noul',
      instructions: `Consider only snippet "${ref}" in state.snippets. ${match.rule.question}`,
    };
  });
  return { model, state: { snippets }, questions };
}

function answersOf(json: unknown): Record<string, unknown> {
  if (typeof json === 'object' && json !== null && 'answers' in json) {
    const { answers } = json;
    if (typeof answers === 'object' && answers !== null && !Array.isArray(answers)) {
      return answers as Record<string, unknown>;
    }
  }
  throw new Error('response has no answers object');
}

function modelOf(json: unknown): string {
  if (typeof json === 'object' && json !== null && 'model' in json) {
    const { model } = json;
    if (typeof model === 'string' && model.length > 0) return model;
  }
  throw new Error('response has no model id');
}

const noulOf = (answer: unknown): unknown =>
  typeof answer === 'object' && answer !== null && 'noul' in answer ? answer.noul : undefined;

export function parseVerdicts(json: unknown, refs: readonly string[]): Verdicts {
  const model = modelOf(json);
  const answers = answersOf(json);
  const scores: Record<string, number> = {};
  for (const ref of refs) {
    const noul = noulOf(answers[ref]);
    if (typeof noul !== 'number' || !(noul >= 0 && noul <= 1)) {
      throw new Error(`response has no probability in [0, 1] for "${ref}"`);
    }
    scores[ref] = noul;
  }
  return { model, scores };
}

export function cacheKey({ endpoint, request }: { endpoint: string; request: JevRequest }): string {
  const payload = JSON.stringify({ v: 3, endpoint, request });
  return createHash('sha256').update(payload).digest('hex');
}
