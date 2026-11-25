// Line diff of two accessibility snapshots, so the verifier can send what changed
// instead of the whole page again after every step. Pure and deterministic.

/** A full snapshot is sent at least this often, so the model never drifts far from the real page. */
export const FULL_EVERY = 5;

export interface SnapshotDiff {
  /** Ready to send. Empty when the two snapshots are identical. */
  text: string;
  added: number;
  removed: number;
}

/** The middle part (after trimming the common prefix and suffix) may not exceed this many table cells. */
const MAX_CELLS = 4_000_000;

type Op = { mark: ' ' | '-' | '+'; line: string };

/**
 * Line-based diff of `prev` to `next`: lines added and removed, each with `context`
 * unchanged lines around it; runs of other unchanged lines collapse into one "…" line.
 * Returns undefined when the changed region is too large to diff cheaply (send a full snapshot).
 * Linear in the size of the common prefix and suffix, quadratic only in the changed middle, which is capped.
 */
export function diffSnapshots(prev: string, next: string, context = 2): SnapshotDiff | undefined {
  const a = prev.split('\n');
  const b = next.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) return undefined;

  // Longest common subsequence of the changed middle.
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ mark: ' ', line: a[i]! });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ mark: ' ', line: a[start + i]! });
      i++;
      j++;
    } else if (j < m && (i === n || table[i * w + j + 1]! >= table[(i + 1) * w + j]!)) {
      ops.push({ mark: '+', line: b[start + j]! });
      j++;
    } else {
      ops.push({ mark: '-', line: a[start + i]! });
      i++;
    }
  }
  for (let k = endA; k < a.length; k++) ops.push({ mark: ' ', line: a[k]! });

  const added = ops.filter((o) => o.mark === '+').length;
  const removed = ops.filter((o) => o.mark === '-').length;
  if (added + removed === 0) return { text: '', added, removed };

  const show = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.mark === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) show[k] = true;
  });
  const out: string[] = [];
  let skipped = 0;
  const flush = (): void => {
    if (skipped > 0) out.push(`…|(${skipped} unchanged line${skipped === 1 ? '' : 's'})`);
    skipped = 0;
  };
  ops.forEach((o, idx) => {
    if (!show[idx]) {
      skipped++;
      return;
    }
    flush();
    out.push(`${o.mark}|${o.line}`);
  });
  flush();
  const header = `Snapshot changes since the previous snapshot (+| added line, -| removed line, " |" unchanged context, …| lines left out; every other line is unchanged, with the same refs):`;
  return { text: `${header}\n${out.join('\n')}`, added, removed };
}
