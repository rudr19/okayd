// The four Okayd tools an agent can call over MCP. Handlers take a `cwd`
// so tests (and embedders) never depend on process.cwd().
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseProof, type ProofFile } from '../proof.js';
import { parseJUnit } from '../junit.js';
import { finalize } from '../finalize.js';
import type { Ledger, LedgerEntry, Verdict } from '../ledger.js';

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
  const shown = optString(args, 'dir') ?? '.okayd';
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
        `or call okayd_add_criterion to create one.`,
    );
  }
  let md = names.filter((n) => n.endsWith('.md') && !n.startsWith('ledger-')).sort();
  if (issue) {
    md = md.filter((n) => n === `${issue}.md`);
    if (md.length === 0) throw new ToolFailure(`No proof file ${shown}/${issue}.md. Call okayd_criteria to list what exists, or okayd_add_criterion to create it.`);
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

const okayd_criteria: ToolDefinition = {
  name: 'okayd_criteria',
  description:
    'List the acceptance criteria in the repo\'s proof files (.okayd/<issue>.md) with the exact tag to put in a test title ' +
    'so the test claims that criterion, e.g. "upgrade works [okayd:142.1]". Call this first to learn what you must prove.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Folder holding proof files, relative to the working directory. Default ".okayd".' },
      issue: { type: 'string', description: 'Only list this issue (matches /^[\\w-]+$/), e.g. "142". Default: every proof file.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const { abs, shown } = dirArg(args, ctx);
    const issue = issueArg(args, false);
    const proofs = await loadProofs(abs, shown, issue);
    if (proofs.length === 0) return `No proof files in ${shown}. Add one with okayd_add_criterion.`;
    const lines: string[] = [];
    for (const p of proofs) {
      if (!p.proof) {
        lines.push(`${shown}/${p.file}: cannot read (${p.error})`, '');
        continue;
      }
      lines.push(`#${p.proof.issue} ${p.proof.title} (${shown}/${p.file})`);
      for (const c of p.proof.criteria) lines.push(`  [okayd:${c.id}] ${c.text}`);
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
    const verdict: Verdict = found && (found.verdict === 'met' || found.verdict === 'failed') ? found.verdict : 'untested';
    return { entry: { id: c.id, text: c.text, verdict, tests: found?.tests ?? [] } };
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

const okayd_status: ToolDefinition = {
  name: 'okayd_status',
  description:
    'The definition of done. Call this BEFORE telling the user a task is finished. Reports, per issue, which acceptance criteria are ' +
    'proven (met), failed or untested, based on the ledger the test run wrote. The first line is the verdict ("Done" or "Not done"); ' +
    'a "Next steps" list names every unmet criterion and its tag. Untested counts as not done.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Folder holding proof files and ledgers, relative to the working directory. Default ".okayd".' },
      issue: { type: 'string', description: 'Only report this issue (matches /^[\\w-]+$/). Default: every proof file.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const { abs, shown } = dirArg(args, ctx);
    const issue = issueArg(args, false);
    const proofs = await loadProofs(abs, shown, issue);
    if (proofs.length === 0) return `Not done: no proof files in ${shown}, so nothing is proven. Add criteria with okayd_add_criterion.`;

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
      const { ledger, mtimeMs } = await readLedger(abs, p.proof.issue, warnings);
      if (ledger && mtimeMs !== undefined && p.mtimeMs > mtimeMs) {
        warnings.push(
          `#${p.proof.issue}: ${shown}/${p.file} is newer than its ledger, so the ledger may be out of date. Re-run the tests with the Okayd reporter or \`okayd ingest\`.`,
        );
      }
      const rows = mergeLedger(p.proof, ledger);
      const issueMet = rows.filter((r) => r.entry.verdict === 'met').length;
      total += rows.length;
      met += issueMet;
      body.push(`#${p.proof.issue} ${p.proof.title}: ${issueMet} of ${rows.length} proven${ledger ? '' : ' (untested: no ledger yet — run the tests with the Okayd reporter or `okayd ingest`)'}`);
      for (const { entry: e } of rows) {
        const evidence = e.tests.map((t) => (t.evidence ? `${t.status}, ${t.evidence}` : t.status)).join('; ');
        body.push(`  ${e.verdict.toUpperCase()}  ${e.id} ${e.text}${evidence ? ` (${evidence})` : ''}`);
        if (e.verdict !== 'met') {
          const why =
            e.verdict === 'failed'
              ? 'a tagged test failed; fix the code (not the criterion) and re-run'
              : 'no passing test claims it; write one and tag its title';
          next.push(`${e.id} (${e.verdict}): ${e.text} — ${why}. Tag: [okayd:${e.id}]`);
        }
      }
      body.push('');
    }

    const done = total > 0 && met === total && broken === 0;
    const head = done
      ? 'Done: every criterion proven.'
      : `Not done: ${met} of ${total} criteria proven${broken ? ` (${broken} proof file${broken > 1 ? 's' : ''} unreadable)` : ''}.`;
    const out = [head, '', ...body];
    if (warnings.length) out.push('Warnings:', ...warnings.map((w) => `- ${w}`), '');
    if (next.length) out.push('Next steps:', ...next.map((n) => `- ${n}`));
    return out.join('\n').trimEnd();
  },
};

const okayd_ingest_junit: ToolDefinition = {
  name: 'okayd_ingest_junit',
  description:
    'Turn a JUnit XML test report (from Playwright, Jest, Vitest, pytest, ...) into Okayd ledgers by matching test names that contain ' +
    '[okayd:<issue>.<n>] tags. Run your tests with a JUnit reporter first, then call this, then call okayd_status. ' +
    'Never posts to GitHub. The file must be inside the working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the JUnit XML file, relative to the working directory.' },
      dir: { type: 'string', description: 'Folder holding proof files; ledgers are written here. Default ".okayd".' },
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
    return [...lines, '', 'Call okayd_status for per-criterion detail.'].join('\n');
  },
};

const okayd_add_criterion: ToolDefinition = {
  name: 'okayd_add_criterion',
  description:
    'Append one acceptance criterion ("- [ ] text") to .okayd/<issue>.md, creating the file if needed (then "title" is required). ' +
    'Returns the new criterion id and the tag to put in test titles. Agents may only ADD criteria: there is deliberately no tool to ' +
    'remove or edit them, so a proof can never be weakened to make a task look done. If a criterion is wrong, tell the user.',
  inputSchema: {
    type: 'object',
    properties: {
      issue: { type: 'string', description: 'Issue id, matches /^[\\w-]+$/, e.g. "142".' },
      text: { type: 'string', description: 'The criterion, one line, phrased as observable behaviour a test can check.' },
      title: { type: 'string', description: 'Issue title for the "## #<issue> <title>" heading. Required only when the proof file does not exist yet.' },
      dir: { type: 'string', description: 'Folder holding proof files, relative to the working directory. Default ".okayd".' },
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
    const id = `${issue}.${index}`;
    return `Added criterion ${id} to ${shown}/${issue}.md. Tag its test: [okayd:${id}]`;
  },
};

export const tools: ToolDefinition[] = [okayd_criteria, okayd_status, okayd_ingest_junit, okayd_add_criterion];

/** Run a tool; handler failures become isError results, never throw. */
export async function runTool(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await tool.handler(args, ctx) }] };
  } catch (e) {
    const msg = e instanceof ToolFailure ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}
