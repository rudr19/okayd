// The okproof tools an agent can call over MCP. Handlers take a `cwd`
// so tests (and embedders) never depend on process.cwd().
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseProof, type ProofFile } from '../proof.js';
import { parseJUnit } from '../junit.js';
import { finalize } from '../finalize.js';
import { lintTests } from '../lint.js';
import type { Ledger, LedgerEntry, Verdict } from '../ledger.js';
import { evaluateGate, staleness } from '../gate.js';

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Thrown by handlers for failures the agent should read and act on. */
export class ToolFailure extends Error {}

const ISSUE = /^[\w-]+$/;
const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolFailure(`"${key}" must be a string.`);
  return v;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = optString(args, key);
  if (v === undefined || v.trim() === '') throw new ToolFailure(`"${key}" is required and must be a non-empty string.`);
  return v;
}

/** Resolve a path against cwd and refuse anything that lands outside it. */
export function resolveInside(cwd: string, p: string, label: string): string {
  const root = resolve(cwd);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new ToolFailure(`"${label}" (${p}) is outside the working directory. Use a path inside ${root}.`);
  }
  return abs;
}

function issueArg(args: Record<string, unknown>, required: boolean): string | undefined {
  const issue = required ? reqString(args, 'issue') : optString(args, 'issue');
  if (issue === undefined) return undefined;
  if (!ISSUE.test(issue)) throw new ToolFailure(`"issue" must match /^[\\w-]+$/ (letters, digits, "_" or "-"), got "${issue}".`);
  return issue;
}

function dirArg(args: Record<string, unknown>, ctx: ToolContext): { abs: string; shown: string } {
  const shown = optString(args, 'dir') ?? '.okproof';
  return { abs: resolveInside(ctx.cwd, shown, 'dir'), shown };
}

interface LoadedProof {
  file: string;
  proof?: ProofFile;
  error?: string;
  mtimeMs: number;
}

async function loadProofs(dirAbs: string, shown: string, issue: string | undefined): Promise<LoadedProof[]> {
  let names: string[];
  try {
    names = await readdir(dirAbs);
  } catch {
    throw new ToolFailure(
      `No proof folder at "${shown}". Create ${shown}/<issue>.md with a "## #<issue> <title>" heading and "- [ ] criterion" lines, ` +
        `or call okproof_add_criterion to create one.`,
    );
  }
  let md = names.filter((n) => n.endsWith('.md') && !n.startsWith('ledger-')).sort();
  if (issue) {
    md = md.filter((n) => n === `${issue}.md`);
    if (md.length === 0) throw new ToolFailure(`No proof file ${shown}/${issue}.md. Call okproof_criteria to list what exists, or okproof_add_criterion to create it.`);
  }
  const out: LoadedProof[] = [];
  for (const file of md) {
    const full = join(dirAbs, file);
    // One handle for both, so the time and the text come from the same file
    // (CodeQL js/file-system-race).
    const fh = await open(full, 'r');
    try {
      const mtimeMs = (await fh.stat()).mtimeMs;
      try {
        out.push({ file, proof: parseProof(await fh.readFile('utf8')), mtimeMs });
      } catch (e) {
        out.push({ file, error: (e as Error).message, mtimeMs });
      }
    } finally {
      await fh.close();
    }
  }
  return out;
}

const okproof_criteria: ToolDefinition = {
  name: 'okproof_criteria',
  description:
    'List the acceptance criteria in the repo\'s proof files (.okproof/<issue>.md) with the exact tag to put in a test title ' +
    'so the test claims that criterion, e.g. "upgrade works [okproof:142.1]". Call this first to learn what you must prove.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Folder holding proof files, relative to the working directory. Default ".okproof".' },
      issue: { type: 'string', description: 'Only list this issue (matches /^[\\w-]+$/), e.g. "142". Default: every proof file.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const { abs, shown } = dirArg(args, ctx);
    const issue = issueArg(args, false);
    const proofs = await loadProofs(abs, shown, issue);
    if (proofs.length === 0) return `No proof files in ${shown}. Add one with okproof_add_criterion.`;
    const lines: string[] = [];
    for (const p of proofs) {
      if (!p.proof) {
        lines.push(`${shown}/${p.file}: cannot read (${p.error})`, '');
        continue;
      }
      lines.push(`#${p.proof.issue} ${p.proof.title} (${shown}/${p.file})`);
      for (const c of p.proof.criteria) lines.push(`  [okproof:${c.id}] ${c.text}`);
      lines.push('');
    }
    lines.push('Put the bracketed tag in the title of each test that proves that criterion. A criterion with no passing tagged test is not proven.');
    return lines.join('\n');
  },
};

interface Row {
  entry: LedgerEntry;
}

function mergeLedger(proof: ProofFile, ledger: Ledger | undefined): Row[] {
  return proof.criteria.map((c) => {
    const found = ledger?.entries?.find((e) => e.id === c.id);
    const verdict: Verdict =
      found && (found.verdict === 'met' || found.verdict === 'failed' || found.verdict === 'unproven') ? found.verdict : 'untested';
    return { entry: { id: c.id, text: c.text, verdict, tests: found?.tests ?? [], weak: found?.weak } };
  });
}

async function readLedger(dirAbs: string, issue: string, warnings: string[]): Promise<{ ledger?: Ledger; mtimeMs?: number }> {
  const path = join(dirAbs, `ledger-${issue}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return { ledger: JSON.parse(raw) as Ledger, mtimeMs: (await stat(path)).mtimeMs };
  } catch {
    warnings.push(`#${issue}: ledger-${issue}.json is not valid JSON; treating every criterion as untested. Re-run the tests.`);
    return {};
  }
}

const okproof_status: ToolDefinition = {
  name: 'okproof_status',
  description:
    'The definition of done. Call this BEFORE telling the user a task is finished. Reports, per issue, which acceptance criteria are ' +
    'proven (met), failed or untested, based on the ledger the test run wrote. The first line is the verdict ("Done" or "Not done"); ' +
    'a "Next steps" list names every unmet criterion and its tag. Untested counts as not done, and so does "unproven" (the tagged tests passed but asserted nothing).',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Folder holding proof files and ledgers, relative to the working directory. Default ".okproof".' },
      issue: { type: 'string', description: 'Only report this issue (matches /^[\\w-]+$/). Default: every proof file.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const { abs, shown } = dirArg(args, ctx);
    const issue = issueArg(args, false);
    const proofs = await loadProofs(abs, shown, issue);
    if (proofs.length === 0) return `Not done: no proof files in ${shown}, so nothing is proven. Add criteria with okproof_add_criterion.`;

    // The verdict is the same function `okproof gate` runs; the rows below are detail.
    const gate = await evaluateGate(abs, { issue });
    const warnings: string[] = [];
    const body: string[] = [];
    const next: string[] = [];
    let total = 0;
    let met = 0;
    let broken = 0;

    for (const p of proofs) {
      if (!p.proof) {
        broken++;
        warnings.push(`${shown}/${p.file} cannot be read: ${p.error}`);
        continue;
      }
      let { ledger, mtimeMs } = await readLedger(abs, p.proof.issue, warnings);
      const stale = ledger ? staleness(p.proof, ledger) : undefined;
      if (stale) {
        warnings.push(stale);
        ledger = undefined; // a stale ledger proves nothing
      }
      if (ledger && mtimeMs !== undefined && p.mtimeMs > mtimeMs) {
        warnings.push(
          `#${p.proof.issue}: ${shown}/${p.file} is newer than its ledger, so the ledger may be out of date. Re-run the tests with the okproof reporter or \`okproof ingest\`.`,
        );
      }
      const rows = mergeLedger(p.proof, ledger);
      const issueMet = rows.filter((r) => r.entry.verdict === 'met').length;
      total += rows.length;
      met += issueMet;
      body.push(`#${p.proof.issue} ${p.proof.title}: ${issueMet} of ${rows.length} proven${ledger ? '' : ' (untested: no ledger yet — run the tests with the okproof reporter or `okproof ingest`)'}`);
      for (const { entry: e } of rows) {
        const evidence = e.tests.map((t) => (t.evidence ? `${t.status}, ${t.evidence}` : t.status)).join('; ');
        body.push(`  ${e.verdict.toUpperCase()}  ${e.id} ${e.text}${evidence ? ` (${evidence})` : ''}`);
        if (e.verdict !== 'met') {
          const weakNames = (e.weak && e.weak.length > 0 ? e.weak : e.tests.map((t) => t.title)).join(', ');
          const why =
            e.verdict === 'failed'
              ? 'a tagged test failed; fix the code (not the criterion) and re-run'
              : e.verdict === 'unproven'
                ? `add a real assertion to ${weakNames}: it passed but asserted nothing, and silence is not proof`
                : 'no passing test claims it; write one and tag its title';
          next.push(`${e.id} (${e.verdict}): ${e.text} — ${why}. Tag: [okproof:${e.id}]`);
        }
      }
      body.push('');
    }

    const done = total > 0 && met === total && broken === 0 && gate.ok;
    const head = done
      ? 'Done: every criterion proven.'
      : met === total && total > 0 && broken === 0
        ? `Not done: ${met} of ${total} criteria proven, but okproof gate fails (see below).`
        : `Not done: ${met} of ${total} criteria proven${broken ? ` (${broken} proof file${broken > 1 ? 's' : ''} unreadable)` : ''}.`;
    for (const problem of gate.problems) {
      if (!problem.includes(' criterion ') && !warnings.includes(problem)) warnings.push(problem);
    }
    const out = [head, '', ...body];
    if (warnings.length) out.push('Warnings:', ...warnings.map((w) => `- ${w}`), '');
    if (next.length) out.push('Next steps:', ...next.map((n) => `- ${n}`));
    return out.join('\n').trimEnd();
  },
};

const okproof_ingest_junit: ToolDefinition = {
  name: 'okproof_ingest_junit',
  description:
    'Turn a JUnit XML test report (from Playwright, Jest, Vitest, pytest, ...) into okproof ledgers by matching test names that contain ' +
    '[okproof:<issue>.<n>] tags. Run your tests with a JUnit reporter first, then call this, then call okproof_status. ' +
    'Never posts to GitHub. The file must be inside the working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the JUnit XML file, relative to the working directory.' },
      dir: { type: 'string', description: 'Folder holding proof files; ledgers are written here. Default ".okproof".' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const file = reqString(args, 'file');
    const fileAbs = resolveInside(ctx.cwd, file, 'file');
    const { abs, shown } = dirArg(args, ctx);
    let xml: string;
    try {
      xml = await readFile(fileAbs, 'utf8');
    } catch {
      throw new ToolFailure(`Cannot read JUnit file "${file}". Run your tests with a JUnit reporter first and pass the path it wrote.`);
    }
    const outcomes = parseJUnit(xml);
    if (outcomes.length === 0) throw new ToolFailure(`"${file}" contains no <testcase> elements. Is it a JUnit XML report?`);
    await loadProofs(abs, shown, undefined); // friendly error when the folder is missing
    const { ledgers, lines } = await finalize(outcomes, { dir: abs, github: false });
    if (ledgers.length === 0) throw new ToolFailure(`No proof files in ${shown} to build ledgers from.`);
    return [...lines, '', 'Call okproof_status for per-criterion detail.'].join('\n');
  },
};

const okproof_add_criterion: ToolDefinition = {
  name: 'okproof_add_criterion',
  description:
    'Append one acceptance criterion ("- [ ] text") to .okproof/<issue>.md, creating the file if needed (then "title" is required). ' +
    'Returns the new criterion id and the tag to put in test titles. Agents may only ADD criteria: there is deliberately no tool to ' +
    'remove or edit them, so a proof can never be weakened to make a task look done. If a criterion is wrong, tell the user.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'string', description: 'Issue id, matches /^[\\w-]+$/, e.g. "142".' },
      text: { type: 'string', description: 'The criterion, one line, phrased as observable behaviour a test can check.' },
      title: { type: 'string', description: 'Issue title for the "## #<issue> <title>" heading. Required only when the proof file does not exist yet.' },
      dir: { type: 'string', description: 'Folder holding proof files, relative to the working directory. Default ".okproof".' },
    },
    required: ['issue', 'text'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const issue = issueArg(args, true)!;
    const text = reqString(args, 'text').trim();
    if (/[\r\n]/.test(text)) throw new ToolFailure('"text" must be a single line.');
    const title = optString(args, 'title')?.trim();
    if (title && /[\r\n]/.test(title)) throw new ToolFailure('"title" must be a single line.');
    const { abs, shown } = dirArg(args, ctx);
    const path = join(abs, `${issue}.md`);

    let existing: string | undefined;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = undefined;
    }

    let index: number;
    if (existing === undefined) {
      if (!title) throw new ToolFailure(`${shown}/${issue}.md does not exist yet. Pass "title" so it can be created with a "## #${issue} <title>" heading.`);
      await mkdir(abs, { recursive: true });
      await writeFile(path, `## #${issue} ${title}\n\n- [ ] ${text}\n`, { flag: 'wx' });
      index = 1;
    } else {
      index = existing.split(/\r?\n/).filter((l) => ITEM.test(l)).length + 1;
      const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
      await writeFile(path, `${existing}${sep}- [ ] ${text}\n`);
    }
    const added = parseProof(await readFile(path, 'utf8')).criteria.at(-1);
    const id = added?.id ?? `${issue}.${index}`;
    return `Added criterion ${id} to ${shown}/${issue}.md. Tag its test: [okproof:${id}]`;
  },
};

const okproof_lint: ToolDefinition = {
  name: 'okproof_lint',
  description:
    'Static check for weak and unrelated tests: finds tests tagged [okproof:<id>] whose body has no assertion or only trivial ones (expect(true).toBe(true)), ' +
    'tests whose body never mentions any key word of the criterion they claim (reported as "possibly unrelated", advisory), tags that name a criterion no proof file lists, ' +
    'and criteria no tagged test claims. A tag is a claim; an assertion is evidence. Heuristic, never runs your tests. Paths must stay inside the working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Project root to scan, relative to the working directory. Default ".". Proof files are read from <dir>/.okproof.' },
      tests: { type: 'string', description: 'Limit the scan to this directory, file or simple glob (relative to dir), e.g. "tests/ui" or "tests/**/*.spec.ts".' },
      strictRelevance: { type: 'boolean', description: 'Treat "possibly unrelated" findings as failures. Default false (advisory).' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const dir = resolveInside(ctx.cwd, optString(args, 'dir') ?? '.', 'dir');
    const tests = optString(args, 'tests');
    if (tests !== undefined) resolveInside(dir, tests.replace(/[*?].*$/, ''), 'tests');
    let result;
    try {
      result = await lintTests({ dir, tests, strictRelevance: args.strictRelevance === true });
    } catch (e) {
      throw new ToolFailure((e as Error).message);
    }
    const head = !result.ok
      ? 'Lint failed: fix the items below.'
      : result.unrelated.length > 0
        ? `Lint passed with ${result.unrelated.length} possibly-unrelated warning${result.unrelated.length === 1 ? '' : 's'}: check that those tests really exercise their criterion.`
        : 'Lint passed: no weak or unrelated tests, no dangling tags.';
    return [head, '', ...result.lines].join('\n');
  },
};

export const tools: ToolDefinition[] = [okproof_criteria, okproof_status, okproof_ingest_junit, okproof_add_criterion, okproof_lint];

/** Run a tool; handler failures become isError results, never throw. */
export async function runTool(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await tool.handler(args, ctx) }] };
  } catch (e) {
    const msg = e instanceof ToolFailure ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}
