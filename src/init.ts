// okproof init: one-step adoption. Scaffolds .okproof/, and optionally a CI workflow and
// the files that teach coding agents the okproof loop. Never overwrites existing files.
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_MARKER = '<!-- okproof -->';

/** The section appended to AGENTS.md / CLAUDE.md. Also shown in the README. */
export const AGENT_SNIPPET = `${AGENT_MARKER}
## okproof: definition of done

This repo checks work against acceptance criteria in \`.okproof/<issue>.md\`.

1. Read \`.okproof/<issue>.md\` before you start. Each criterion has an id such as \`142.1\`.
2. Tag every test that covers a criterion with \`[okproof:<id>]\` in its title, for example
   \`test('member can upgrade [okproof:142.1]', ...)\`.
3. Run the tests, then \`npx okproof ingest <results>\` (JUnit XML or CTRF JSON) and
   \`npx okproof gate\` (or call the MCP tool \`okproof_status\`). Keep working until it says proven.
4. Never edit or remove existing criteria without telling the user exactly what you changed and why.
5. Add a real assertion to every tagged test. Untested, flaky and assertion-less tests never count.
`;

export const RUNNERS = ['playwright', 'junit', 'ctrf', 'vitest', 'jest', 'pytest'] as const;
export type Runner = (typeof RUNNERS)[number];

export interface InitOptions {
  cwd: string;
  issue?: string;
  title?: string;
  runner?: Runner;
  agents?: boolean;
  workflow?: boolean;
}

export interface InitResult {
  created: string[];
  updated: string[];
  skipped: string[];
  lines: string[];
}

// Pins copied from this repo's own workflows (see .github/workflows/ci.yml).
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2';
const SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class Tracker {
  created: string[] = [];
  updated: string[] = [];
  skipped: string[] = [];
  constructor(private cwd: string) {}
  /** Write a new file; skip when it exists. */
  async create(rel: string, content: string, why = 'already exists'): Promise<boolean> {
    const abs = join(this.cwd, rel);
    if (await exists(abs)) {
      this.skipped.push(`${rel} (${why})`);
      return false;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    this.created.push(rel);
    return true;
  }
}

export function exampleProof(issue?: string, title?: string): { name: string; content: string } {
  if (issue !== undefined) {
    const t = title?.trim() || `Issue #${issue}`;
    return {
      name: `${issue}.md`,
      content: `## #${issue} ${t}\n- [ ] Replace this with the first acceptance criterion (or run: npx okproof sync --issue ${issue})\n`,
    };
  }
  return {
    name: '1.md',
    content:
      '## #1 Example: replace with your own acceptance criteria\n' +
      '- [ ] A user can do the first thing the issue asks for\n' +
      '- [ ] The second thing the issue asks for works and is visible in the UI\n',
  };
}

export function workflowFor(runner: Runner): string {
  let setup: string;
  let results: string;
  switch (runner) {
    case 'playwright':
      results = 'junit.xml';
      setup = `      - run: npm ci
      # Playwright's JUnit reporter does not mark retried-then-passed tests as flaky.
      # For flaky detection add the okproof reporter too: reporter: [['junit'], ['okproof/playwright']]
      - run: npx playwright install --with-deps chromium
      - name: Run tests (JUnit)
        run: npx playwright test --reporter=junit
        env:
          PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit.xml`;
      break;
    case 'vitest':
      results = 'junit.xml';
      setup = `      - run: npm ci
      - name: Run tests (JUnit)
        run: npx vitest run --reporter=junit --outputFile=junit.xml`;
      break;
    case 'jest':
      results = 'junit.xml';
      setup = `      # Needs the jest-junit package: npm i -D jest-junit
      - run: npm ci
      - name: Run tests (JUnit)
        run: npx jest --ci --reporters=default --reporters=jest-junit
        env:
          JEST_JUNIT_OUTPUT_DIR: .
          JEST_JUNIT_OUTPUT_NAME: junit.xml`;
      break;
    case 'pytest':
      results = 'junit.xml';
      setup = `      # Set up Python and install your dependencies here (for example actions/setup-python).
      - name: Run tests (JUnit)
        run: python -m pytest --junitxml=junit.xml`;
      break;
    case 'ctrf':
      results = 'ctrf-report.json';
      setup = `      - run: npm ci
      # Run your tests with a CTRF reporter so they write ctrf-report.json.
      - name: Run tests (CTRF)
        run: npm test`;
      break;
    default:
      results = 'junit.xml';
      setup = `      - run: npm ci
      # Replace with your test command. It must write JUnit XML to junit.xml.
      - name: Run tests (JUnit)
        run: npm test`;
  }
  return `name: okproof
on: pull_request

permissions:
  contents: read

jobs:
  prove:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # lets okproof post and update its one PR comment
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${SETUP_NODE}
        with:
          node-version: 22
${setup}
      - id: okproof
        if: \${{ !cancelled() }}
        uses: rudr19/okproof@v0
        with:
          results: ${results}
`;
}

async function appendSection(t: Tracker, cwd: string, rel: string): Promise<void> {
  const abs = join(cwd, rel);
  if (!(await exists(abs))) {
    await writeFile(abs, AGENT_SNIPPET);
    t.created.push(rel);
    return;
  }
  const current = await readFile(abs, 'utf8');
  if (current.includes(AGENT_MARKER)) {
    t.skipped.push(`${rel} (okproof section already present)`);
    return;
  }
  const sep = current.length === 0 || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(abs, current + sep + AGENT_SNIPPET);
  t.updated.push(`${rel} (okproof section appended)`);
}

async function mergeMcp(t: Tracker, cwd: string): Promise<void> {
  const rel = '.mcp.json';
  const abs = join(cwd, rel);
  const server = { command: 'npx', args: ['okproof', 'mcp'] };
  if (!(await exists(abs))) {
    await writeFile(abs, JSON.stringify({ mcpServers: { okproof: server } }, null, 2) + '\n');
    t.created.push(rel);
    return;
  }
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(abs, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    json = parsed as Record<string, unknown>;
  } catch {
    t.skipped.push(`${rel} (not valid JSON; left untouched, add the okproof server by hand)`);
    return;
  }
  const servers = json.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    t.skipped.push(`${rel} (mcpServers is not an object; left untouched)`);
    return;
  }
  const map = (servers ?? {}) as Record<string, unknown>;
  if ('okproof' in map) {
    t.skipped.push(`${rel} (okproof server already configured)`);
    return;
  }
  json.mcpServers = { ...map, okproof: server };
  await writeFile(abs, JSON.stringify(json, null, 2) + '\n');
  t.updated.push(`${rel} (okproof server added)`);
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { cwd } = opts;
  const runner = opts.runner ?? 'playwright';
  if (!RUNNERS.includes(runner)) throw new Error(`Unknown --runner "${runner}". Use one of: ${RUNNERS.join(', ')}.`);
  if (opts.issue !== undefined && !/^[\w-]+$/.test(opts.issue)) throw new Error('--issue must be an issue number (letters, digits, - and _ only).');
  const t = new Tracker(cwd);

  const proof = exampleProof(opts.issue, opts.title);
  await t.create(`.okproof/${proof.name}`, proof.content);

  if (opts.workflow) await t.create('.github/workflows/okproof.yml', workflowFor(runner));

  if (opts.agents) {
    await appendSection(t, cwd, 'AGENTS.md');
    await appendSection(t, cwd, 'CLAUDE.md');
    const skill = await readFile(fileURLToPath(new URL('../../skills/okproof/SKILL.md', import.meta.url)), 'utf8');
    await t.create('.claude/skills/okproof/SKILL.md', skill);
    await mergeMcp(t, cwd);
  }

  const lines: string[] = [];
  for (const f of t.created) lines.push(`created  ${f}`);
  for (const f of t.updated) lines.push(`updated  ${f}`);
  for (const f of t.skipped) lines.push(`skipped  ${f}`);
  const id = proof.name.replace(/\.md$/, '');
  lines.push('', 'Next steps:');
  lines.push(`  1. Edit .okproof/${proof.name}: one "- [ ]" line per acceptance criterion (or: npx okproof sync --issue <n>).`);
  lines.push('  2. npx okproof check   # prints the [okproof:<id>] tag for each criterion');
  lines.push(`  3. Put the tag in test titles, e.g. test('does the thing [okproof:${id}.1]', ...)`);
  lines.push('  4. Run your tests with a JUnit reporter, then: npx okproof ingest junit.xml && npx okproof gate');
  if (!opts.workflow) lines.push('  5. Add CI with: npx okproof init --workflow --runner <runner>');
  else lines.push('  5. Commit .github/workflows/okproof.yml and make the "prove" job a required check.');
  lines.push('  Tip: protect .okproof/ with CODEOWNERS (for example "/.okproof/ @your-team") so criteria cannot change without review.');
  return { created: t.created, updated: t.updated, skipped: t.skipped, lines };
}
