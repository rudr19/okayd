// Where a proof file came from. `okproof sync` records, on the line under the heading:
//
//   <!-- okproof:issue updated_at=2026-11-20T10:00:00Z sha256=<hex> proof_sha256=<hex> -->
//
//   sha256        digest of the issue's criteria (and title) as of the sync
//   proof_sha256  digest of the proof file's own content (heading and criteria, not this line)
//   updated_at    the issue's updated_at, for people only. Never compared: labels and comments
//                 bump it, so a check keyed on it would fail for no reason.
//
// `sync --check` compares three things (recorded, local, issue) and so can say whether the
// issue changed since the sync or the proof file was edited by hand. A proof file without the
// line behaves as before. Everything here is string scanning: no regular expression runs on
// file or issue text.
import { createHash } from 'node:crypto';

const PREFIX = '<!-- okproof:issue';
const SUFFIX = '-->';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const isHex64 = (s: string): boolean => s.length === 64 && [...s].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
// A UTC timestamp as GitHub writes it. Anything else is dropped rather than written into a file.
const isTimestamp = (s: string): boolean => s.length >= 20 && s.length <= 30 && s.endsWith('Z') && [...s].every((c) => (c >= '0' && c <= '9') || '-:.TZ'.includes(c));

export interface Provenance {
  updatedAt?: string;
  /** Digest of the issue criteria at sync time. */
  issueSha256?: string;
  /** Digest of the proof file content (marker line excluded) at sync time. */
  proofSha256?: string;
}

/** Digest of what an issue asks for: its title and its criteria text, in order, whitespace-normalised. */
export function issueDigest(title: string, criteria: string[]): string {
  return sha(`${title}\n${criteria.join('\n')}`);
}

/** Digest of a proof file with the provenance line removed and line endings normalised. */
export function proofDigest(text: string): string {
  return sha(withoutMarker(text).split('\r\n').join('\n'));
}

function markerRange(text: string): { start: number; end: number } | undefined {
  const start = text.startsWith(PREFIX) ? 0 : (() => {
    const i = text.indexOf(`\n${PREFIX}`);
    return i < 0 ? -1 : i + 1;
  })();
  if (start < 0) return undefined;
  const lineEnd = text.indexOf('\n', start);
  const end = lineEnd < 0 ? text.length : lineEnd + 1;
  const line = text.slice(start, lineEnd < 0 ? text.length : lineEnd).trimEnd();
  if (!line.endsWith(SUFFIX)) return undefined;
  return { start, end };
}

/** `text` without its provenance line (all of it when there is none). */
export function withoutMarker(text: string): string {
  const r = markerRange(text);
  return r ? text.slice(0, r.start) + text.slice(r.end) : text;
}

export function formatMarker(p: Provenance): string {
  const parts = [PREFIX];
  if (p.updatedAt !== undefined && isTimestamp(p.updatedAt)) parts.push(`updated_at=${p.updatedAt}`);
  if (p.issueSha256 !== undefined) parts.push(`sha256=${p.issueSha256}`);
  if (p.proofSha256 !== undefined) parts.push(`proof_sha256=${p.proofSha256}`);
  parts.push(SUFFIX);
  return parts.join(' ');
}

/** The provenance recorded in a proof file, or undefined when there is no (well-formed) line. */
export function parseMarker(text: string): Provenance | undefined {
  const r = markerRange(text);
  if (!r) return undefined;
  const line = text.slice(r.start, r.end).trim();
  const inner = line.slice(PREFIX.length, line.length - SUFFIX.length);
  const out: Provenance = {};
  for (const token of inner.split(' ')) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === 'updated_at' && isTimestamp(value)) out.updatedAt = value;
    else if (key === 'sha256' && isHex64(value)) out.issueSha256 = value;
    else if (key === 'proof_sha256' && isHex64(value)) out.proofSha256 = value;
  }
  return out.issueSha256 !== undefined || out.proofSha256 !== undefined ? out : undefined;
}

export type DriftCause = 'issue' | 'local' | 'both' | 'neither' | 'unrecorded';

/**
 * Why a proof file differs from its issue. Call it only when it does differ.
 *   issue       the issue changed since the sync; the file is as synced
 *   local       the file was edited since the sync; the issue is as synced
 *   both        both moved
 *   neither     both digests match the record, yet they disagree (a hand-edited record)
 *   unrecorded  the file carries no record, so the cause cannot be told
 */
export function driftCause(recorded: Provenance | undefined, now: { issueSha256: string; proofSha256: string }): DriftCause {
  if (recorded?.issueSha256 === undefined || recorded.proofSha256 === undefined) return 'unrecorded';
  const issue = recorded.issueSha256 !== now.issueSha256;
  const local = recorded.proofSha256 !== now.proofSha256;
  return issue && local ? 'both' : issue ? 'issue' : local ? 'local' : 'neither';
}

export function describeDrift(cause: DriftCause, issue: number): string {
  switch (cause) {
    case 'issue':
      return `the issue changed since the proof file was synced. Review what changed, then run: okproof sync --issue ${issue}`;
    case 'local':
      return `the proof file was edited locally since it was synced (the issue is unchanged). Put the change in the issue, or run okproof sync --issue ${issue} to discard it`;
    case 'both':
      return `the issue changed and the proof file was also edited locally since the last sync. Reconcile both, then run: okproof sync --issue ${issue}`;
    case 'neither':
      return `the proof file differs from the issue although neither changed since the recorded sync (the okproof:issue line was edited by hand?). Run: okproof sync --issue ${issue}`;
    default:
      return `this proof file has no okproof:issue record, so it cannot be said whether the issue or the file changed. Run okproof sync --issue ${issue} once to record it`;
  }
}
