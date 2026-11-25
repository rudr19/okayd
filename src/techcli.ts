// Command-line handlers for `okproof diff` and `okproof revert-check`.
import { runDifferential } from './differential.js';
import { runRevertCheck } from './revert.js';

interface Parsed {
  values: Map<string, string>;
  switches: Set<string>;
  positional: string[];
}

function parse(list: string[], valued: string[], switches: string[], command: string): Parsed {
  const out: Parsed = { values: new Map(), switches: new Set(), positional: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (switches.includes(key) && eq === -1) out.switches.add(key);
    else if (valued.includes(key)) {
      const v = eq === -1 ? list[++i] : a.slice(eq + 1);
      if (v === undefined || (eq === -1 && v.startsWith('--'))) throw new Error(`--${key} needs a value.`);
      out.values.set(key, v);
    } else throw new Error(`Unknown option ${a} for okproof ${command}.`);
  }
  return out;
}

function positiveInt(p: Parsed, key: string, fallback: number, max: number): number {
  const raw = p.values.get(key);
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) throw new Error(`--${key} takes a whole number from 1 to ${max}, got "${raw}".`);
  return Number(raw);
}

function common(p: Parsed, command: string, format: string | undefined) {
  const test = p.values.get('test');
  const results = p.values.get('results');
  if (!test || !results) throw new Error(`okproof ${command} needs --test "<command>" and --results <file> (the file your test command writes).`);
  const f = p.values.get('format') ?? format;
  if (f !== undefined && f !== 'junit' && f !== 'ctrf') throw new Error(`Unknown --format "${f}". Use junit or ctrf.`);
  return { test, results, format: f, base: p.values.get('base'), issue: p.values.get('issue'), dir: p.positional[0], timeoutSec: positiveInt(p, 'timeout', 600, 86400) };
}

/** okproof diff: returns the exit code (0 proven, 1 problems, 2 could not run). */
export async function runDiffCommand(list: string[], format: string | undefined): Promise<number> {
  try {
    const p = parse(list, ['base', 'test', 'results', 'format', 'issue', 'timeout'], ['allow-preexisting'], 'diff');
    const r = await runDifferential({ ...common(p, 'diff', format), allowPreexisting: p.switches.has('allow-preexisting'), log: (l) => console.log(l) });
    if (!r.ok) console.error('okproof diff: some criteria are not proven by this change (not-differential, regressed or failing).');
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}

/** okproof revert-check: returns the exit code (0 covered, 1 uncovered, 2 could not run). */
export async function runRevertCommand(list: string[], format: string | undefined): Promise<number> {
  try {
    const p = parse(list, ['base', 'test', 'results', 'format', 'issue', 'timeout', 'max-runs'], ['allow-uncovered'], 'revert-check');
    const r = await runRevertCheck({
      ...common(p, 'revert-check', format),
      allowUncovered: p.switches.has('allow-uncovered'),
      maxRuns: positiveInt(p, 'max-runs', 20, 1000),
      log: (l) => console.log(l),
    });
    if (!r.ok) console.error('okproof revert-check: some criteria are uncovered: their tests do not exercise the change.');
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}
