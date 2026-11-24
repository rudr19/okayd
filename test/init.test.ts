import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit, AGENT_MARKER, AGENT_SNIPPET, RUNNERS } from '../src/init.js';
import { parseProof } from '../src/proof.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'okproof-init-'));
const read = (cwd: string, rel: string) => readFile(join(cwd, rel), 'utf8');

test('init creates a parseable example proof file', async () => {
  const cwd = await tmp();
  const r = await runInit({ cwd });
  assert.deepEqual(r.created, ['.okproof/1.md']);
  assert.ok(parseProof(await read(cwd, '.okproof/1.md')).criteria.length >= 1);
  assert.ok(r.lines.some((l) => l.startsWith('Next steps')));
});

test('init --issue --title writes that proof file', async () => {
  const cwd = await tmp();
  await runInit({ cwd, issue: '142', title: 'Pro upgrade' });
  const proof = parseProof(await read(cwd, '.okproof/142.md'));
  assert.equal(proof.issue, '142');
  assert.equal(proof.title, 'Pro upgrade');
});

test('init never overwrites an existing proof file and says what it skipped', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, '.okproof'));
  await writeFile(join(cwd, '.okproof', '142.md'), '## #142 Mine\n- [ ] keep me\n');
  const r = await runInit({ cwd, issue: '142' });
  assert.equal(await read(cwd, '.okproof/142.md'), '## #142 Mine\n- [ ] keep me\n');
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0]!, /142\.md.*already exists/);
  assert.ok(r.lines.some((l) => l.startsWith('skipped')));
});

test('init rejects an unknown runner and a bad issue id', async () => {
  const cwd = await tmp();
  await assert.rejects(runInit({ cwd, runner: 'mocha' as never }), /Unknown --runner/);
  await assert.rejects(runInit({ cwd, issue: '../x' }), /--issue/);
});

test('--workflow writes pinned, least-privilege YAML for every runner', async () => {
  for (const runner of RUNNERS) {
    const cwd = await tmp();
    await runInit({ cwd, workflow: true, runner });
    const yml = await read(cwd, '.github/workflows/okproof.yml');
    assert.match(yml, /uses: rudr19\/okproof@v0/);
    assert.match(yml, /contents: read/);
    assert.match(yml, /pull-requests: write/);
    assert.match(yml, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(yml, /actions\/setup-node@[0-9a-f]{40}/);
    assert.match(yml, /results: (junit\.xml|ctrf-report\.json)/);
  }
});

test('--workflow runner commands', async () => {
  const get = async (runner: (typeof RUNNERS)[number]) => {
    const cwd = await tmp();
    await runInit({ cwd, workflow: true, runner });
    return read(cwd, '.github/workflows/okproof.yml');
  };
  assert.match(await get('playwright'), /playwright test --reporter=junit/);
  assert.match(await get('vitest'), /vitest run --reporter=junit --outputFile=junit\.xml/);
  assert.match(await get('jest'), /jest-junit/);
  assert.match(await get('pytest'), /pytest --junitxml=junit\.xml/);
  assert.match(await get('ctrf'), /ctrf-report\.json/);
});

test('--workflow does not overwrite an existing workflow', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
  await writeFile(join(cwd, '.github/workflows/okproof.yml'), 'mine');
  const r = await runInit({ cwd, workflow: true });
  assert.equal(await read(cwd, '.github/workflows/okproof.yml'), 'mine');
  assert.match(r.skipped.join('\n'), /okproof\.yml/);
});

test('--agents creates AGENTS.md, CLAUDE.md, the skill and .mcp.json', async () => {
  const cwd = await tmp();
  await runInit({ cwd, agents: true });
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const text = await read(cwd, f);
    assert.ok(text.includes(AGENT_MARKER));
    assert.ok(text.includes('[okproof:<id>]'));
    assert.ok(text.includes('npx okproof gate'));
  }
  assert.equal(await read(cwd, '.claude/skills/okproof/SKILL.md'), await readFile(fileURLToPath(new URL('../../skills/okproof/SKILL.md', import.meta.url)), 'utf8'));
  assert.deepEqual(JSON.parse(await read(cwd, '.mcp.json')), { mcpServers: { okproof: { command: 'npx', args: ['okproof', 'mcp'] } } });
});

test('--agents appends to existing AGENTS.md/CLAUDE.md once (idempotent)', async () => {
  const cwd = await tmp();
  await writeFile(join(cwd, 'AGENTS.md'), '# My rules\n\nBe nice.\n');
  await runInit({ cwd, agents: true });
  const once = await read(cwd, 'AGENTS.md');
  assert.ok(once.startsWith('# My rules\n\nBe nice.\n\n'));
  assert.ok(once.endsWith(AGENT_SNIPPET));
  const r = await runInit({ cwd, agents: true });
  assert.equal(await read(cwd, 'AGENTS.md'), once);
  assert.equal(r.created.length, 0);
  assert.equal(r.updated.length, 0);
  assert.equal((await read(cwd, 'CLAUDE.md')).split(AGENT_MARKER).length, 2);
});

test('.mcp.json merge keeps other servers and other keys', async () => {
  const cwd = await tmp();
  await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ other: 1, mcpServers: { github: { command: 'gh-mcp' } } }));
  await runInit({ cwd, agents: true });
  const json = JSON.parse(await read(cwd, '.mcp.json'));
  assert.equal(json.other, 1);
  assert.deepEqual(json.mcpServers.github, { command: 'gh-mcp' });
  assert.deepEqual(json.mcpServers.okproof, { command: 'npx', args: ['okproof', 'mcp'] });
});

test('.mcp.json: existing okproof entry and invalid JSON are left alone', async () => {
  const a = await tmp();
  const custom = JSON.stringify({ mcpServers: { okproof: { command: 'custom' } } });
  await writeFile(join(a, '.mcp.json'), custom);
  await runInit({ cwd: a, agents: true });
  assert.equal(await read(a, '.mcp.json'), custom);
  const b = await tmp();
  await writeFile(join(b, '.mcp.json'), '{ not json');
  const r = await runInit({ cwd: b, agents: true });
  assert.equal(await read(b, '.mcp.json'), '{ not json');
  assert.match(r.skipped.join('\n'), /not valid JSON/);
});

test('--agents does not overwrite an existing skill file', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, '.claude', 'skills', 'okproof'), { recursive: true });
  await writeFile(join(cwd, '.claude/skills/okproof/SKILL.md'), 'mine');
  await runInit({ cwd, agents: true });
  assert.equal(await read(cwd, '.claude/skills/okproof/SKILL.md'), 'mine');
});

test('CLI: okproof init --agents --workflow --runner playwright --yes', async () => {
  const cwd = await tmp();
  const r = spawnSync(process.execPath, [cli, 'init', '--agents', '--workflow', '--runner', 'playwright', '--yes'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /created {2}\.github\/workflows\/okproof\.yml/);
  assert.match(r.stdout, /Next steps/);
  const check = spawnSync(process.execPath, [cli, 'check'], { cwd, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const bad = spawnSync(process.execPath, [cli, 'init', '--runner', 'nope'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown --runner/);
});

test('README carries the exact agent snippet that init writes', async () => {
  const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  assert.ok(readme.split('\r\n').join('\n').includes(AGENT_SNIPPET.trimEnd()), 'README snippet drifted from src/init.ts AGENT_SNIPPET');
});

test('no doc links to the removed governance files', async () => {
  for (const f of ['README.md', 'CONTRIBUTING.md', 'WHY.md']) {
    const text = await readFile(fileURLToPath(new URL(`../../${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /\]\((?:\.\/)?(?:VISION|WHY-OKPROOF|GOVERNANCE|ROADMAP)\.md/);
  }
});
