import type { Location, Range } from '@oxlint/plugins';

export type Target = 'function' | 'call' | 'jsx' | 'file';

export type CiBehavior = 'skip' | 'fail';

export interface LayaRule {
  /** Unique within the rule list. Shown in the lint message. */
  id: string;
  target: Target;
  /** One English yes/no question. "Yes" means "report an error". */
  question: string;
  /** Report when Laya's yes-probability is >= this. Between 0 and 1. */
  cutoff: number;
}

export interface LayaOptions {
  ci?: CiBehavior;
  timeoutMs?: number;
  maxMatchesPerFile?: number;
  maxSnippetChars?: number;
  model?: string;
  rules: LayaRule[];
}

/** Options as a rule sees them, with `meta.defaultOptions` already merged underneath by oxlint. */
export type ResolvedOptions = Required<LayaOptions>;

export interface RequestMatch {
  readonly rule: { readonly question: string };
  readonly snippet: string;
}

export interface Match extends RequestMatch {
  readonly rule: LayaRule;
  readonly loc: Location;
}

export interface LayaRequest {
  model: string;
  state: { snippets: Record<string, string> };
  questions: Record<string, { type: 'noul'; instructions: string }>;
}

export interface Verdicts {
  /** The model id returned by the server, such as `laya-rl-agent`. */
  readonly model: string;
  readonly scores: Record<string, number>;
}

export interface AskInput {
  apiKey?: string;
  baseURL: string;
  request: LayaRequest;
  timeoutMs: number;
}

export type AskResult = { ok: true; json: unknown } | { ok: false; reason: string };

export interface SnippetNode {
  readonly type: string;
  readonly range: Range;
  readonly parent?: NamedParent | null | undefined;
}

export interface NamedParent extends SnippetNode {
  readonly init?: unknown;
  readonly value?: unknown;
}

export interface ReportNode {
  readonly loc: Location;
  readonly openingElement?: { readonly loc: Location } | undefined;
}

/** The public shape of the default export. Consumers load the plugin by name, so the rule
 * internals are deliberately not part of the published type. */
export interface LayaPlugin {
  meta: { name: string };
  rules: { ask: object };
}
