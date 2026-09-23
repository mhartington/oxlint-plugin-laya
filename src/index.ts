import type {
  Context,
  ESTree,
  Plugin,
  RuleMeta,
  SourceCode,
  VisitorWithHooks,
} from '@oxlint/plugins';
import { defaultCacheDir, readCache, writeCache } from './cache.ts';
import {
  buildRequest,
  cacheKey,
  messageOf,
  parseVerdicts,
  refAt,
  truncateSnippet,
} from './laya.ts';
import {
  checkOptions,
  DEFAULTS,
  REPORT_LOC,
  SCHEMA,
  snippetNodeFor,
  TARGET_NODE_TYPES,
} from './options.ts';
import { askLaya } from './sync-laya.ts';
import type { LayaPlugin, LayaRule, Match, ResolvedOptions, Verdicts } from './types.ts';

export type { CiBehavior, LayaOptions, LayaPlugin, LayaRule, Target } from './types.ts';

const optionsByRaw = new WeakMap<object, ResolvedOptions>();
const warnedReasons = new Set<string>();

function warnOnce(reason: string, message: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`oxlint-plugin-laya: ${message}`);
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

const baseURL = (): string =>
  ((process.env.LAYA_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

const snippetOf = (sourceCode: SourceCode, node: ESTree.Node): string =>
  node.type === 'Program' ? sourceCode.text : sourceCode.getText(node);

function optionsFor(raw: unknown): ResolvedOptions {
  if (typeof raw !== 'object' || raw === null) return checkOptions(raw);
  const cached = optionsByRaw.get(raw);
  if (cached !== undefined) return cached;
  const options = checkOptions(raw);
  optionsByRaw.set(raw, options);
  return options;
}

function rulesByNodeType(rules: readonly LayaRule[]): Map<string, LayaRule[]> {
  const byType = new Map<string, LayaRule[]>();
  for (const rule of rules) {
    for (const type of TARGET_NODE_TYPES[rule.target]) {
      byType.set(type, [...(byType.get(type) ?? []), rule]);
    }
  }
  return byType;
}

function degrade(context: Context, options: ResolvedOptions, reason: string): null {
  if (process.env.CI && options.ci === 'fail') {
    throw new Error(`oxlint-plugin-laya: ${reason} (${context.filename})`);
  }
  warnOnce(reason, `${reason} (${context.filename})`);
  return null;
}

function verdictsFor(
  context: Context,
  options: ResolvedOptions,
  matches: readonly Match[],
  apiKey: string,
): Verdicts | null {
  const dir = defaultCacheDir();
  const url = baseURL();
  const request = buildRequest(options.model, matches);
  const key = cacheKey({ endpoint: url, request });
  const refs = matches.map((_, index) => refAt(index));
  const cached = readCache(dir, key, refs);
  if (cached !== null) return cached;

  const result = askLaya({ apiKey, baseURL: url, request, timeoutMs: options.timeoutMs });
  if (!result.ok) return degrade(context, options, result.reason);
  let verdicts: Verdicts;
  try {
    verdicts = parseVerdicts(result.json, refs);
  } catch (error) {
    return degrade(context, options, messageOf(error));
  }
  try {
    writeCache(dir, key, result.json);
  } catch (error) {
    warnOnce('cache-write', `could not write cache in ${dir}: ${messageOf(error)}`);
  }
  return verdicts;
}

const byTypeByOptions = new WeakMap<ResolvedOptions, Map<string, LayaRule[]>>();

function nodeTypeIndex(options: ResolvedOptions): Map<string, LayaRule[]> {
  const cached = byTypeByOptions.get(options);
  if (cached !== undefined) return cached;
  const byType = rulesByNodeType(options.rules);
  byTypeByOptions.set(options, byType);
  return byType;
}

interface FilePass {
  readonly options: ResolvedOptions;
  readonly apiKey: string;
  readonly byType: Map<string, LayaRule[]>;
  readonly matches: Match[];
  dropped: number;
}

function createOnce(context: Context): VisitorWithHooks {
  let pass: FilePass | null = null;

  const collect = (type: string, node: ESTree.Node): void => {
    if (pass === null) return;
    const rules = pass.byType.get(type);
    if (rules === undefined) return;
    for (const rule of rules) {
      if (pass.matches.length >= pass.options.maxMatchesPerFile) {
        pass.dropped += 1;
        return;
      }
      const own = snippetOf(context.sourceCode, node);
      const named = snippetNodeFor(node);
      const text = named === node ? own : context.sourceCode.getText(named);
      pass.matches.push({
        rule,
        loc: REPORT_LOC[rule.target](node, own),
        snippet: truncateSnippet(text, pass.options.maxSnippetChars),
      });
    }
  };

  const visitors: VisitorWithHooks = {};
  for (const type of Object.values(TARGET_NODE_TYPES).flat()) {
    visitors[type] = (node) => collect(type, node);
  }

  // `Program` carries the per-file setup as well as the `file` target, because oxlint does not
  // guarantee `before` runs for every file.
  visitors.Program = (node) => {
    const options = optionsFor(context.options[0]);
    const apiKey = (process.env.LAYA_API_KEY ?? '').trim();
    pass = { options, apiKey, byType: nodeTypeIndex(options), matches: [], dropped: 0 };
    collect('Program', node);
  };

  visitors['Program:exit'] = () => {
    const collected = pass;
    pass = null;
    if (collected === null || collected.matches.length === 0) return;
    if (collected.dropped > 0) {
      const cap = collected.options.maxMatchesPerFile;
      const total = collected.matches.length + collected.dropped;
      warnOnce(
        `capped:${context.filename}`,
        `${total} matches exceeded maxMatchesPerFile=${cap}, ${collected.dropped} not checked (${context.filename})`,
      );
    }
    const verdicts = verdictsFor(context, collected.options, collected.matches, collected.apiKey);
    if (verdicts === null) return;
    collected.matches.forEach((match, index) => {
      const score = verdicts.scores[refAt(index)];
      if (score >= match.rule.cutoff) {
        const { id, cutoff, question } = match.rule;
        context.report({
          loc: match.loc,
          messageId: 'yes',
          data: {
            id,
            model: verdicts.model,
            score: score.toFixed(2),
            cutoff: cutoff.toFixed(2),
            question,
          },
        });
      }
    });
  };
  return visitors;
}

const meta = {
  type: 'problem',
  docs: {
    description:
      "Ask Laya a plain-English yes/no question about matched code and report when the yes-probability clears the rule's cutoff.",
  },
  schema: [SCHEMA],
  defaultOptions: [DEFAULTS],
  messages: { yes: '[{{id}}] {{model}} answered yes ({{score}} >= {{cutoff}}): {{question}}' },
} satisfies RuleMeta;

const plugin: LayaPlugin = {
  meta: { name: 'laya' },
  rules: { ask: { meta, createOnce } },
} satisfies Plugin;

export default plugin;
