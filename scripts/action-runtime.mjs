// Used by action.yml: puts a built okproof into $GITHUB_ACTION_PATH/dist, the folder every
// later step runs from.
//
//   runtime=published (default)  Installs the exact version in this action's own package.json
//       from the npm registry into a temporary folder, checks it with `npm audit signatures`
//       (registry signature and, for okproof, its provenance attestation), and copies that
//       verified package's dist/ into place. What runs is the published, attested tarball:
//       there is no `npm ci` of dev dependencies and no compile on consumer runs. Any failure
//       (version not on npm, signature check fails, offline) stops the job. It never falls
//       back to building from source: a fallback an attacker could trigger by blocking the
//       registry would defeat the check.
//   runtime=source               `npm ci` and `tsc` in the action folder. For a ref that is not
//       a release (this repository's own self-test, a fork, a branch under test).
//
// The version comes from the package.json next to this script, which belongs to the same
// commit as action.yml, so the action ref decides the version; nothing else does.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org/';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** The version to run: exactly MAJOR.MINOR.PATCH, so no range, tag or prerelease can slip in. */
export function exactVersion(packageJsonText) {
  let v;
  try {
    v = JSON.parse(packageJsonText).version;
  } catch {
    throw new Error('the action package.json is not valid JSON.');
  }
  if (typeof v !== 'string' || !EXACT_VERSION.test(v)) {
    throw new Error(`the action package.json version "${String(v)}" is not an exact release version (MAJOR.MINOR.PATCH). Use runtime: source for a ref that is not a release.`);
  }
  return v;
}

/** Real command runner. npm is npm.cmd on Windows and needs a shell there; arguments are never user text. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: cmd === 'npm' && process.platform === 'win32', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Installs and verifies okproof@version, then copies its dist/ to `<actionPath>/dist`.
 * `exec(cmd, args, {cwd})` is injectable so tests need no network.
 */
export function installPublished({ version, actionPath, workDir, registry = REGISTRY, exec = run, log = console.log }) {
  const fail = (msg) => {
    throw new Error(msg);
  };
  const npm = (args, cwd, what) => {
    const r = exec('npm', ['--registry', registry, ...args], { cwd });
    if (r.status !== 0) fail(`${what} failed:\n${(r.stdout + r.stderr).trim()}`);
    return r.stdout;
  };

  // 1. The version must exist on the registry.
  const view = npm(['view', `okproof@${version}`, 'version', '--json'], workDir, `npm view okproof@${version}`);
  let seen;
  try {
    seen = JSON.parse(view);
  } catch {
    seen = undefined;
  }
  if (seen !== version) fail(`okproof@${version} is not published on npm (registry answered ${JSON.stringify(view.trim())}). Use runtime: source for a ref that is not a release.`);
  log(`okproof@${version} is published.`);

  // 2. One install, into a folder of its own, scripts off. That same copy is verified and run.
  const prefix = join(workDir, 'runtime');
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, 'package.json'), JSON.stringify({ name: 'okproof-action-runtime', version: '0.0.0', private: true }) + '\n');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `okproof@${version}`], prefix, `npm install okproof@${version}`);

  // 3. Registry signatures and provenance attestations of what was just installed.
  npm(['audit', 'signatures'], prefix, 'npm audit signatures');
  log(`npm audit signatures passed for okproof@${version}.`);

  const pkgDir = join(prefix, 'node_modules', 'okproof');
  let installed;
  try {
    installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    installed = undefined;
  }
  if (installed !== version) fail(`installed okproof version ${String(installed)} is not ${version}.`);
  if (!existsSync(join(pkgDir, 'dist', 'src', 'cli.js'))) fail('the published package has no dist/src/cli.js.');

  // 4. Put the verified build where the action's steps expect it.
  const target = join(actionPath, 'dist');
  rmSync(target, { recursive: true, force: true });
  cpSync(join(pkgDir, 'dist'), target, { recursive: true });
  log(`Using the published okproof@${version} build.`);
}

export function installFromSource({ actionPath, exec = run, log = console.log }) {
  for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'build']]) {
    const r = exec('npm', args, { cwd: actionPath, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${actionPath}.`);
  }
  log('Built okproof from source (runtime: source).');
}

export function main(env = process.env) {
  const runtime = (env.RUNTIME || 'published').trim();
  const actionPath = resolve(env.GITHUB_ACTION_PATH || fileURLToPath(new URL('..', import.meta.url)));
  if (runtime === 'source') return installFromSource({ actionPath });
  if (runtime !== 'published') throw new Error(`runtime must be "published" or "source", got "${runtime}".`);
  const version = exactVersion(readFileSync(join(actionPath, 'package.json'), 'utf8'));
  const base = env.RUNNER_TEMP || tmpdir();
  mkdirSync(base, { recursive: true });
  const workDir = mkdtempSync(join(base, 'okproof-runtime-'));
  try {
    installPublished({ version, actionPath, workDir });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`::error::okproof: ${e.message}`);
    process.exit(1);
  }
}
