#!/usr/bin/env node
// okayd check  [dir] [--issue-body <file> [--issue N]]
//                                 validate proof files and print each criterion's tag;
//                                 with --issue-body, fail if the issue's checkboxes differ

// okayd ingest <file> [dir]       build ledgers from JUnit XML or CTRF JSON (--format junit|ctrf)
// okayd gate   [dir] [--allow-empty]
//                                 exit 1 unless every proof file has a fresh, fully met ledger
// okayd mcp                       serve Okayd to coding agents over MCP (stdio)
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof, compareToIssueBody } from './proof.js';
import { evaluateGate } from './gate.js';
import { parseJUnit } from './junit.js';
import { parseCTRF } from './ctrf.js';
import { finalize } from './finalize.js';
import { AnthropicModel, MISSING_KEY_MESSAGE, type Effort } from './verify/model.js';
import { replayOnly, verify } from './verify/run.js';
import { startMcpServer } from './mcp/server.js';

const USAGE = 'Usage: okayd check [dir] [--issue-body <file> [--issue N]] | okayd ingest <junit.xml|ctrf.json> [dir] [--format junit|ctrf] | okayd gate [dir] [--allow-empty] | okayd mcp | okayd verify --url <baseUrl> [options]';
const argv = process.argv.slice(2);
let format: string | undefined;
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--format') format = argv[++i];
  else if (argv[i].startsWith('--format=')) format = argv[i].slice('--format='.length);
  else args.push(argv[i]);
}

// okayd verify --url <baseUrl> [--issue N] [--dir .okayd] [--max-steps 15] [--model id] [--effort e] [--replay-only]
function flags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), true);
    else { out.set(a.slice(2), next); i++; }
  }
  return out;
}

async function runVerify(): Promise<number> {
  const f = flags(args.slice(1));
  const str = (k: string): string | undefined => (typeof f.get(k) === 'string' ? (f.get(k) as string) : undefined);
  const dir = str('dir') ?? '.okayd';
  const issue = str('issue');
  const url = str('url');
  if (f.get('replay-only') === true) {
    const results = await replayOnly({ dir, issue, baseUrl: url, chrome: process.env.OKAYD_CHROME });
    if (results.length === 0) {
      console.error(`No repro files in ${dir}/repro. Run okayd verify first.`);
      return 2;
    }
    let reproduced = false;
    for (const r of results) {
      console.log(`${r.criterionId}: ${r.reproduced ? 'BUG REPRODUCED' : 'not reproduced'}`);
      for (const l of r.lines) console.log(`  ${l}`);
      reproduced ||= r.reproduced;
    }
    return reproduced ? 1 : 0;
  }
  if (!url) {
    console.error(`Name the app to test with --url <baseUrl>. ${USAGE}`);
    return 2;
  }
  let model: AnthropicModel;
  try {
    model = new AnthropicModel({ model: str('model'), effort: str('effort') as Effort | undefined });
  } catch (e) {
    const message = (e as Error).message;
    console.error(message === MISSING_KEY_MESSAGE ? `${message}\nTo re-run saved repro scripts without a model, add --replay-only.` : message);
    return 2;
  }
  const runs = await verify({ dir, issue, baseUrl: url, model, maxSteps: Number(str('max-steps') ?? 15), log: (l) => console.log(l) });
  let refuted = false;
  for (const run of runs) {
    for (const r of run.results) {
      console.log(`${r.criterionId}: ${r.verdict}${r.repro ? ` (repro: ${r.repro})` : ''}`);
      for (const x of r.findings) console.log(`  ${x.confirmed ? 'confirmed' : 'unconfirmed'} [${x.severity}] ${x.title}`);
      refuted ||= r.verdict === 'refuted';
    }
  }
  return refuted ? 1 : 0;
}
/** Arguments that are neither a flag nor the value of one of `valued`. */
function positional(list: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (!a.startsWith('--')) out.push(a);
    else if (valued.includes(a.slice(2))) i++;
  }
  return out;
}
const cmd = args[0] ?? 'check';

async function main(): Promise<number> {
  if (cmd === 'check') {
    const f = flags(args.slice(1));
    const value = (k: string): string | undefined => (typeof f.get(k) === 'string' ? (f.get(k) as string) : undefined);
    const bodyFile = value('issue-body');
    if (f.get('issue-body') === true) {
      console.error(`--issue-body needs a file holding the issue text. ${USAGE}`);
      return 2;
    }
    const dir = positional(args.slice(1), ['issue-body', 'issue'])[0] ?? '.okayd';
    const proofs = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('ledger-'))) {
      const proof = parseProof(await readFile(join(dir, name), 'utf8'));
      proofs.push(proof);
      console.log(`#${proof.issue} ${proof.title}`);
      for (const c of proof.criteria) console.log(`  [okayd:${c.id}] ${c.text}`);
    }
    if (bodyFile === undefined) return 0;
    const wanted = value('issue');
    const target = wanted ? proofs.find((p) => p.issue === wanted.replace(/^#/, '')) : proofs.length === 1 ? proofs[0] : undefined;
    if (!target) {
      console.error(wanted ? `No proof file for issue #${wanted.replace(/^#/, '')} in ${dir}.` : `${proofs.length} proof files in ${dir}: say which one the issue body belongs to with --issue <number>.`);
      return 2;
    }
    const drift = compareToIssueBody(target, await readFile(bodyFile, 'utf8'));
    if (drift.onlyInIssue.length === 0 && drift.onlyInProof.length === 0) {
      console.log(`#${target.issue}: proof file matches the issue body.`);
      return 0;
    }
    console.error(`#${target.issue}: proof file and issue body disagree.`);
    for (const t of drift.onlyInIssue) console.error(`  in the issue, missing from the proof file: ${t}`);
    for (const t of drift.onlyInProof) console.error(`  in the proof file, missing from the issue: ${t}`);
    return 1;
  }
  if (cmd === 'ingest') {
    const file = args[1];
    if (!file) {
      console.error(`Name the JUnit XML or CTRF JSON file to read. ${USAGE}`);
      return 2;
    }
    if (format !== undefined && format !== 'junit' && format !== 'ctrf') {
      console.error(`Unknown --format "${format}". Use junit or ctrf. ${USAGE}`);
      return 2;
    }
    const text = await readFile(file, 'utf8');
    const kind = format ?? (file.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{') ? 'ctrf' : 'junit');
    const outcomes = kind === 'ctrf' ? parseCTRF(text) : parseJUnit(text);
    const { lines } = await finalize(outcomes, {
      dir: args[2] ?? '.okayd',
      // The GitHub Action sets this when its `comment` input is false.
      github: process.env.OKAYD_NO_COMMENT !== '1',
    });
    for (const line of lines) console.log(line);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = positional(args.slice(1), [])[0] ?? '.okayd';
    const result = await evaluateGate(dir, { allowEmpty: args.includes('--allow-empty') });
    for (const n of result.notes) console.log(n);
    for (const p of result.problems) console.error(p);
    return result.ok ? 0 : 1;
  }
  if (cmd === 'mcp') {
    await startMcpServer(process.stdin, process.stdout);
    return 0;
  }
  if (cmd === 'verify') return runVerify();
  console.error(`Unknown command "${cmd}". ${USAGE}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(2);
  },
);
