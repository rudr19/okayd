// Supply chain: the Action runs the published, attested package; init writes pinned references.
// Nothing here uses the network: the npm calls are replaced by a recording fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { okproofActionRef, packageVersion, pinnedNpx, releaseCommit, RELEASE_COMMIT } from '../src/release-info.js';
import { workflowFor } from '../src/init.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const load = (name: string) => import(pathToFileURL(join(root, 'scripts', name)).href);
const runtime = await load('action-runtime.mjs');
const stampMod = await load('stamp-release.mjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';

test('release-info: a placeholder or malformed commit is "unknown"; a 40-hex sha is known', () => {
  assert.equal(releaseCommit('__OKPROOF_RELEASE_COMMIT__'), undefined);
  assert.equal(releaseCommit('abc123'), undefined);
  assert.equal(releaseCommit(SHA.toUpperCase()), undefined);
  assert.equal(releaseCommit(`${SHA}\n`), undefined);
  assert.equal(releaseCommit(SHA), SHA);
  // The repository build is never stamped, or the fallback path would be untested in CI.
  assert.equal(releaseCommit(RELEASE_COMMIT), undefined);
});

test('okproofActionRef: SHA pin with a version comment, or v0 with a pin-me comment', () => {
  const pinned = okproofActionRef({ commit: SHA, version: '0.3.0' });
  assert.equal(pinned.uses, `rudr19/okproof@${SHA} # v0.3.0`);
  assert.deepEqual(pinned.comments, []);
  assert.equal(pinned.pinned, true);
  const unknown = okproofActionRef({ commit: 'nope', version: '0.3.0' });
  assert.equal(unknown.uses, 'rudr19/okproof@v0');
  assert.equal(unknown.pinned, false);
  assert.ok(unknown.comments.every((c) => c.startsWith('#')));
  assert.match(unknown.comments.join('\n'), /Pin this to a full commit SHA/);
});

test('workflowFor writes the SHA pin when the commit is known, and valid-looking YAML lines', () => {
  const yml = workflowFor('vitest', okproofActionRef({ commit: SHA, version: '0.3.0' }));
  assert.match(yml, new RegExp(`uses: rudr19/okproof@${SHA} # v0\\.3\\.0\\n`));
  assert.doesNotMatch(yml, /okproof@v0/);
  const fallback = workflowFor('vitest', okproofActionRef({ commit: undefined, version: '0.3.0' }));
  const lines = fallback.split('\n');
  const at = lines.findIndex((l) => l.includes('uses: rudr19/okproof@v0'));
  assert.ok(at > 0);
  assert.match(lines[at - 5]!, /^ {6}# Tags can be moved/); // comments sit above the step, indented with it
  assert.equal(lines[at - 3]!.trim(), '# (the release page and the tag list show each release commit).');
});

test('pinnedNpx names an exact version, and package.json agrees', () => {
  assert.equal(pinnedNpx('1.2.3'), 'npx okproof@1.2.3');
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test('stamp-release replaces the placeholder once, and only with a full sha', async () => {
  const src = await readFile(join(root, 'src', 'release-info.ts'), 'utf8');
  assert.equal(src.split(stampMod.PLACEHOLDER).length - 1, 1, 'exactly one placeholder in src/release-info.ts');
  const out = stampMod.stamp(src, SHA);
  assert.ok(out.includes(`'${SHA}'`));
  assert.ok(!out.includes(stampMod.PLACEHOLDER));
  assert.throws(() => stampMod.stamp(src, 'abc'), /40-character/);
  assert.throws(() => stampMod.stamp(src, SHA.toUpperCase()), /40-character/);
  assert.throws(() => stampMod.stamp(out, SHA), /no release placeholder/);
});

test('release.yml stamps the commit before it builds', async () => {
  const yml = await readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  const stamp = yml.indexOf('scripts/stamp-release.mjs');
  assert.ok(stamp > 0);
  assert.ok(stamp < yml.indexOf('run: npm test'), 'stamp runs before npm test (which builds)');
  assert.ok(stamp < yml.indexOf('run: npm pack'));
});

test('action runtime: only an exact MAJOR.MINOR.PATCH version is accepted', () => {
  assert.equal(runtime.exactVersion('{"version":"0.3.0"}'), '0.3.0');
  for (const bad of ['{"version":"0.3.0-rc.1"}', '{"version":"^0.3.0"}', '{"version":"latest"}', '{"version":"0.3"}', '{"version":"0.3.0 && x"}', '{}', 'not json']) {
    assert.throws(() => runtime.exactVersion(bad), /./, bad);
  }
});

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** A fake npm: records calls, answers `view`, and "installs" a package on `install`. */
function fakeNpm(version: string, opts: { view?: string; auditFails?: boolean } = {}) {
  const calls: Call[] = [];
  const exec = (cmd: string, args: string[], o: { cwd?: string } = {}) => {
    calls.push({ cmd, args, cwd: o.cwd });
    const sub = args[2];
    if (sub === 'view') return { status: 0, stdout: opts.view ?? JSON.stringify(version), stderr: '' };
    if (sub === 'install') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (sub === 'audit') return opts.auditFails ? { status: 1, stdout: '', stderr: 'signature mismatch' } : { status: 0, stdout: 'audited', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { calls, exec };
}

async function arena(version: string) {
  const base = await mkdtemp(join(tmpdir(), 'okproof-rt-'));
  const actionPath = join(base, 'action');
  const workDir = join(base, 'work');
  await mkdir(join(actionPath, 'dist'), { recursive: true });
  await writeFile(join(actionPath, 'dist', 'stale.js'), 'old');
  await mkdir(workDir, { recursive: true });
  return { actionPath, workDir, version };
}

/** Materialises the package the fake `npm install` is supposed to have fetched. */
async function installFiles(workDir: string, version: string, withCli = true) {
  const pkg = join(workDir, 'runtime', 'node_modules', 'okproof');
  await mkdir(join(pkg, 'dist', 'src'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'okproof', version }));
  if (withCli) await writeFile(join(pkg, 'dist', 'src', 'cli.js'), '// cli');
}

test('published runtime: view, install, audit signatures (same prefix, pinned registry), then swap dist', async () => {
  const a = await arena('0.3.0');
  const npm = fakeNpm('0.3.0');
  // The fake install drops the package files where `npm install` would, before verification reads them.
  const exec = (cmd: string, args: string[], o: { cwd?: string }) => {
    const r = npm.exec(cmd, args, o);
    if (args[2] === 'install') {
      const pkg = join(o.cwd!, 'node_modules', 'okproof');
      mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'okproof', version: '0.3.0' }));
      writeFileSync(join(pkg, 'dist', 'src', 'cli.js'), '// cli');
    }
    return r;
  };
  runtime.installPublished({ version: '0.3.0', actionPath: a.actionPath, workDir: a.workDir, exec, log: () => {} });

  assert.deepEqual(
    npm.calls.map((c) => c.args.slice(2, 4).join(' ')),
    ['view okproof@0.3.0', 'install --ignore-scripts', 'audit signatures'],
  );
  for (const c of npm.calls) {
    assert.equal(c.cmd, 'npm');
    assert.deepEqual(c.args.slice(0, 2), ['--registry', 'https://registry.npmjs.org/'], 'registry is explicit, so a workspace .npmrc cannot redirect it');
  }
  const install = npm.calls.find((c) => c.args[2] === 'install')!;
  assert.ok(install.args.includes('okproof@0.3.0') && install.args.includes('--ignore-scripts'));
  const audit = npm.calls.find((c) => c.args[2] === 'audit')!;
  assert.equal(audit.cwd, install.cwd, 'the audited folder is the folder that was installed and is run');
  assert.ok(existsSync(join(a.actionPath, 'dist', 'src', 'cli.js')));
  assert.ok(!existsSync(join(a.actionPath, 'dist', 'stale.js')), 'old dist is replaced, not merged');
  assert.ok(!npm.calls.some((c) => c.args.includes('ci') || c.args.includes('build')), 'never builds from source');
});

test('published runtime: a version that is not on npm stops the job; no install, no fallback build', async () => {
  const a = await arena('9.9.9');
  const npm = fakeNpm('9.9.9', { view: '' });
  assert.throws(() => runtime.installPublished({ version: '9.9.9', actionPath: a.actionPath, workDir: a.workDir, exec: npm.exec, log: () => {} }), /not published on npm/);
  assert.equal(npm.calls.length, 1);
  assert.ok(existsSync(join(a.actionPath, 'dist', 'stale.js')), 'dist untouched on failure');
});

test('published runtime: a failed signature audit stops the job and leaves dist alone', async () => {
  const a = await arena('0.3.0');
  const npm = fakeNpm('0.3.0', { auditFails: true });
  await installFiles(a.workDir, '0.3.0');
  assert.throws(() => runtime.installPublished({ version: '0.3.0', actionPath: a.actionPath, workDir: a.workDir, exec: npm.exec, log: () => {} }), /npm audit signatures failed[\s\S]*signature mismatch/);
  assert.ok(existsSync(join(a.actionPath, 'dist', 'stale.js')));
  assert.ok(!npm.calls.some((c) => c.args.includes('build')));
});

test('published runtime: an installed version that differs, or a package without a CLI, is refused', async () => {
  const a = await arena('0.3.0');
  await installFiles(a.workDir, '0.2.0');
  assert.throws(() => runtime.installPublished({ version: '0.3.0', actionPath: a.actionPath, workDir: a.workDir, exec: fakeNpm('0.3.0').exec, log: () => {} }), /is not 0\.3\.0/);
  const b = await arena('0.3.0');
  await installFiles(b.workDir, '0.3.0', false);
  assert.throws(() => runtime.installPublished({ version: '0.3.0', actionPath: b.actionPath, workDir: b.workDir, exec: fakeNpm('0.3.0').exec, log: () => {} }), /no dist\/src\/cli\.js/);
});

test('main rejects an unknown runtime value', () => {
  assert.throws(() => runtime.main({ RUNTIME: 'cache', GITHUB_ACTION_PATH: root }), /must be "published" or "source"/);
});

test('action.yml defaults to the published runtime; the self-test builds from source', async () => {
  const yml = await readFile(join(root, 'action.yml'), 'utf8');
  assert.match(yml, /\n {2}runtime:[\s\S]*?default: published/);
  assert.match(yml, /RUNTIME: \$\{\{ inputs\.runtime \}\}/);
  assert.doesNotMatch(yml, /npm ci --ignore-scripts/, 'consumers no longer npm ci the dev dependencies');
  const selfTest = await readFile(join(root, '.github', 'workflows', 'self-test.yml'), 'utf8');
  assert.match(selfTest, /runtime: source/);
});
