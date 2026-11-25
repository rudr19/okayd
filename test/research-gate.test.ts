// Research findings B-02 / E-1: one gate verdict everywhere (gate, comment, outputs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate } from '../src/gate.js';
import { finalize } from '../src/finalize.js';

const PASS = [{ title: 'a [okproof:142.1]', status: 'passed', assertions: 1 }];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okp-rg-'));
  const dir = join(root, '.okproof');
  await mkdir(dir);
  await writeFile(join(dir, '142.md'), '## #142 Demo\n- [ ] First thing works\n');
  return dir;
}

test('evaluateGate: a linked issue without a proof file is not proven when requireIssues is set', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    assert.equal((await evaluateGate(dir)).ok, true);
    const g = await evaluateGate(dir, { requireIssues: ['142', '143'] });
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /#143 is linked by the pull request but there is no proof file/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('evaluateGate: checkNames catches a heading that names another issue', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    await writeFile(join(dir, '142.md'), '## #999 Swapped\n- [ ] First thing works\n');
    const g = await evaluateGate(dir, { checkNames: true });
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /heading says #999 but the file is named for #142/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('finalize: the PR comment says "not proven" when a linked issue has no proof file, the same as the gate', async () => {
  const dir = await project();
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  const bodies: string[] = [];
  try {
    const summary = join(dir, '..', 'summary.md');
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return new Response(JSON.stringify(init?.method ? { id: 1 } : []), { status: 200 });
    }) as unknown as typeof fetch;
    await finalize(PASS, { dir, requireIssues: ['142', '143'] });
    assert.equal(bodies.length, 1);
    assert.match(bodies[0]!, /not proven yet/);
    assert.match(bodies[0]!, /#143 is linked by the pull request/);
    bodies.length = 0;
    await finalize(PASS, { dir, requireIssues: ['142'] });
    assert.match(bodies[0]!, /every criterion proven/);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF']) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});
