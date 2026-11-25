// Runs the compiled tests the same way on Node 20 and 22, Windows and Linux.
// `--coverage` adds Node's built-in coverage report (no dependency, no threshold): it only prints.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = join('dist', 'test');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => join(dir, f));
if (files.length === 0) {
  console.error(`No compiled tests in ${dir}. Run npm run build first.`);
  process.exit(1);
}
const coverage = process.argv.includes('--coverage') ? ['--experimental-test-coverage'] : [];
const { status } = spawnSync(process.execPath, ['--test', ...coverage, ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
