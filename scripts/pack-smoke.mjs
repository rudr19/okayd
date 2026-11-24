// Packs the package exactly as `npm publish` would, extracts the tarball into a
// temp dir (nothing is installed), then runs the packed CLI and imports every
// export path. Run `npm run build` first (`npm test` does). Exits non-zero on
// any failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

function run(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows and needs a shell; node and tar do not.
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: cmd === 'npm' && process.platform === 'win32', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

const root = process.cwd();
if (!existsSync(join(root, 'dist', 'src', 'cli.js'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'okproof-smoke-'));
try {
  // 1. npm pack (scripts off: we pack what was built, and avoid recursion).
  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  const pack = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: root });
  if (pack.status !== 0) {
    console.error(pack.stderr || pack.error);
    throw new Error('npm pack failed');
  }
  const info = JSON.parse(pack.stdout)[0];
  ok(`packed ${info.filename} (${info.files.length} files, ${(info.size / 1024).toFixed(1)} kB)`);
  const packed = new Set(info.files.map((f) => f.path));
  for (const want of ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'TRADEMARK.md', 'dist/src/cli.js', 'skills/okproof/SKILL.md']) {
    if (!packed.has(want)) fail(`tarball is missing ${want}`);
  }
  for (const path of packed) {
    if (path.startsWith('src/') || path.startsWith('test/') || path.startsWith('.github/') || path.startsWith('dist/test/')) {
      fail(`tarball contains ${path}, which should not ship`);
    }
  }

  // 2. Extract. A relative archive name and cwd avoid drive-letter trouble in tar on Windows.
  const outDir = join(work, 'extracted');
  mkdirSync(outDir);
  const tar = run('tar', ['-xzf', join('..', 'pack', info.filename)], { cwd: outDir });
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.error);
    throw new Error('could not extract the tarball');
  }
  const pkgDir = join(outDir, 'package');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length > 0) fail('package has runtime dependencies');

  // 3. bin and exports must point at files that exist in the tarball.
  const cli = join(pkgDir, pkg.bin.okproof);
  if (!existsSync(cli)) fail(`bin.okproof points at missing ${pkg.bin.okproof}`);
  if (!readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node')) fail('bin.okproof has no node shebang');
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    for (const [cond, rel] of Object.entries(target)) {
      if (!existsSync(join(pkgDir, rel))) fail(`exports["${subpath}"].${cond} points at missing ${rel}`);
    }
  }
  if (!existsSync(join(pkgDir, pkg.main))) fail(`main points at missing ${pkg.main}`);
  if (!existsSync(join(pkgDir, pkg.types))) fail(`types points at missing ${pkg.types}`);

  // 4. Run the packed CLI against a temp fixture. The cwd is the fixture, not the repo.
  const project = join(work, 'project');
  mkdirSync(join(project, '.okproof'), { recursive: true });
  writeFileSync(
    join(project, '.okproof', '1.md'),
    '## #1 Smoke test\n- [ ] A visitor can sign in\n- [ ] A visitor can sign out\n',
  );
  const env = { ...process.env, OKPROOF_NO_COMMENT: '1' };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  const cliRun = (...args) => run(process.execPath, [cli, ...args], { cwd: project, env });
  const expect = (label, r, code, mustInclude) => {
    if (r.status !== code) fail(`${label}: exit ${r.status}, wanted ${code}\n${r.stdout}${r.stderr}`);
    else if (mustInclude && !(r.stdout + r.stderr).includes(mustInclude)) fail(`${label}: output lacks "${mustInclude}"\n${r.stdout}${r.stderr}`);
    else ok(`${label} -> exit ${code}`);
  };

  expect('okproof check', cliRun('check'), 0, '[okproof:1.1]');
  expect('okproof gate with no ledger', cliRun('gate'), 1);
  expect('okproof (unknown command)', cliRun('nonsense'), 2);

  const junit = (second) => `<?xml version="1.0"?>
<testsuites><testsuite name="smoke" tests="2">
  <testcase classname="auth" name="sign in [okproof:1.1]"/>
  ${second}
</testsuite></testsuites>
`;
  writeFileSync(join(project, 'partial.xml'), junit('<testcase classname="auth" name="sign out [okproof:1.2]"><failure message="boom"/></testcase>'));
  expect('okproof ingest (one failing)', cliRun('ingest', 'partial.xml'), 0);
  expect('okproof gate with a failed criterion', cliRun('gate'), 1);

  writeFileSync(join(project, 'all.xml'), junit('<testcase classname="auth" name="sign out [okproof:1.2]"/>'));
  expect('okproof ingest (all passing)', cliRun('ingest', 'all.xml'), 0);
  expect('okproof gate with every criterion met', cliRun('gate'), 0);

  // A proof file edited after the ledger was written must not pass.
  writeFileSync(join(project, '.okproof', '1.md'), '## #1 Smoke test\n- [ ] A visitor can sign in\n- [ ] A visitor can sign out\n- [ ] A visitor can reset a password\n');
  expect('okproof gate with a stale ledger', cliRun('gate'), 1, 'STALE');

  // 5. import() every export path from the extracted package.
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    try {
      const mod = await import(pathToFileURL(join(pkgDir, target.default)).href);
      if (Object.keys(mod).length === 0) fail(`import ${subpath} has no exports`);
      else ok(`import ${subpath} (${Object.keys(mod).length} exports)`);
    } catch (err) {
      fail(`import ${subpath}: ${err.message}`);
    }
  }
} catch (err) {
  fail(err.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nPack smoke test passed.');
