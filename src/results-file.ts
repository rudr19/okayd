// Reading a test-results file (JUnit XML or CTRF JSON) with a size cap, so a
// huge or hostile file is refused with a clear message before it is read.
import { open } from 'node:fs/promises';
import { MAX_RESULTS_BYTES } from './junit.js';

/** Reads `path` as UTF-8. Throws a plain-language error when it is larger than `max` bytes. */
export async function readResultsFile(path: string, max: number = MAX_RESULTS_BYTES): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size > max) {
      throw new Error(`${path} is ${size} bytes, larger than the ${max >= 1024 * 1024 ? `${Math.round(max / (1024 * 1024))} MB` : `${max} byte`} limit for test results. Split the report or drop noisy output (system-out).`);
    }
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}
