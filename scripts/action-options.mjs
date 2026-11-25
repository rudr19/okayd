// Used by action.yml: turns the Action inputs into one set of OKPROOF_* environment
// variables, once, so the ingest and gate steps do not each parse them again.
// The okproof CLI reads these variables (see src/cli.ts). Nothing here runs a
// shell: values are validated, must be a single line, and are written to
// $GITHUB_ENV as NAME=value.
//
// Fails (exit 1) when the gate would trust committed ledgers by accident: gate is
// "true", no `results` input is given and allow-committed-ledgers is not "true".
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** True when `dir` holds at least one proof file (an .md that is not a ledger rendering). */
export function hasProofFiles(dir, readdir = readdirSync) {
  try {
    return readdir(dir).some((n) => n.endsWith('.md') && !n.startsWith('ledger-'));
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string | undefined>} e  the step's environment (one variable per input)
 * @param {boolean} proofFiles  whether the proof folder holds proof files
 * @returns {{ env: Record<string, string>, outputs: Record<string, string>, errors: string[], warnings: string[] }}
 */
export function resolveOptions(e, proofFiles) {
  const errors = [];
  const warnings = [];
  const bool = (name, raw, def) => {
    const s = (raw ?? '').trim().toLowerCase();
    if (s === '') return def;
    if (s === 'true') return true;
    if (s === 'false') return false;
    errors.push(`${name} must be "true" or "false", got "${raw}".`);
    return def;
  };
  const single = (name, raw) => {
    if (/[\r\n\0]/.test(raw)) {
      errors.push(`${name} must be a single line.`);
      return '';
    }
    return raw;
  };

  const gate = bool('gate', e.GATE, true);
  const results = single('results', (e.RESULTS ?? '').trim());
  const allowCommitted = bool('allow-committed-ledgers', e.ALLOW_COMMITTED, false);
  const strictAssertions = bool('strict-assertions', e.STRICT_ASSERTIONS, true);
  const strictRelevance = bool('strict-relevance', e.STRICT_RELEVANCE, true);
  const allowEmpty = bool('allow-empty', e.ALLOW_EMPTY, false);
  const requireLinked = bool('require-linked', e.REQUIRE_LINKED, true);
  const requireLinkedProof = bool('require-linked-proof', e.REQUIRE_LINKED_PROOF, requireLinked);
  const requireVerify = bool('require-verify', e.REQUIRE_VERIFY, false);

  let lint = single('lint', (e.LINT ?? 'auto').trim());
  if (lint === '') lint = 'auto';
  if (lint.startsWith('-')) {
    errors.push(`lint must be "auto", "off" or a path or glob, got "${lint}".`);
    lint = 'off';
  }

  const maxClaims = single('max-claims', (e.MAX_CLAIMS ?? '').trim());
  if (maxClaims !== '' && !/^[1-9]\d{0,5}$/.test(maxClaims)) errors.push(`max-claims must be a positive whole number, got "${maxClaims}".`);

  if (gate && results === '' && !allowCommitted) {
    errors.push(
      'okproof: no `results` input was given, so the ledger is not bound to a test run in this job. The gate would trust committed ledger files, which anyone who can commit can forge. Set the results input to your JUnit or CTRF file, or set allow-committed-ledgers: true if you accept that risk.',
    );
  }
  if (gate && results === '' && allowCommitted) {
    warnings.push('okproof: allow-committed-ledgers is true and no results input was given: the gate trusts committed ledger files. Anyone who can commit can forge one.');
  }
  if (strictAssertions && lint === 'off') {
    warnings.push('okproof: strict-assertions is on and lint is off, so every test whose runner reports no assertion count is unproven. Turn lint on (the default) or set strict-assertions: false.');
  }

  const empty = allowEmpty && !proofFiles;
  const env = {
    OKPROOF_LINT: lint,
    OKPROOF_STRICT_ASSERTIONS: strictAssertions ? '1' : '0',
    OKPROOF_STRICT_RELEVANCE: strictRelevance ? '1' : '0',
    OKPROOF_MAX_CLAIMS: maxClaims,
    OKPROOF_ALLOW_EMPTY: allowEmpty ? '1' : '0',
    OKPROOF_REQUIRE_VERIFY: requireVerify ? '1' : '0',
    OKPROOF_REQUIRE_LINKED_PROOF: requireLinkedProof ? '1' : '0',
  };
  return { env, outputs: { empty: String(empty) }, errors, warnings };
}

function main() {
  const dir = process.env.DIR || '.okproof';
  const r = resolveOptions(
    {
      GATE: process.env.GATE,
      RESULTS: process.env.RESULTS,
      ALLOW_COMMITTED: process.env.ALLOW_COMMITTED,
      STRICT_ASSERTIONS: process.env.STRICT_ASSERTIONS,
      STRICT_RELEVANCE: process.env.STRICT_RELEVANCE,
      ALLOW_EMPTY: process.env.ALLOW_EMPTY,
      REQUIRE_LINKED: process.env.REQUIRE_LINKED,
      REQUIRE_LINKED_PROOF: process.env.REQUIRE_LINKED_PROOF,
      REQUIRE_VERIFY: process.env.REQUIRE_VERIFY,
      LINT: process.env.LINT,
      MAX_CLAIMS: process.env.MAX_CLAIMS,
    },
    existsSync(dir) && hasProofFiles(dir),
  );
  for (const w of r.warnings) console.log(`::warning::${w}`);
  for (const m of r.errors) console.error(`::error::${m}`);
  if (r.errors.length > 0) process.exit(1);
  const lines = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}\n`).join('');
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, lines(r.env));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines(r.outputs));
  else process.stdout.write(lines({ ...r.env, ...r.outputs }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
