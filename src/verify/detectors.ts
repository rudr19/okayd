// Deterministic, model-free bug detectors. They run after every action and
// never ask a model anything, so what they report is reproducible.

import type { Page, Problems } from '../driver/index.js';
import { parseSnapshotRefs } from './actions.js';

export type FindingKind =
  | 'console-error'
  | 'page-exception'
  | 'http-error'
  | 'request-failed'
  | 'unnamed-control'
  | 'broken-link'
  | 'horizontal-overflow'
  | 'violation';

export interface Finding {
  kind: FindingKind;
  /** 1 (cosmetic) to 5 (broken). Severity 3 and above can refute a criterion. */
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  detail: string;
  url: string;
  /** Index of the action after which this was seen. */
  step: number;
}

/** A confirmed finding at or above this severity refutes the criterion. */
export const REFUTE_SEVERITY = 3;

export interface ProblemCursor {
  console: number;
  network: number;
}

const clip = (s: string, n = 160): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Turns problems logged since `cursor` into findings. Pure. */
export function problemFindings(
  problems: Problems,
  cursor: ProblemCursor,
  ctx: { url: string; step: number; offline?: boolean },
): Finding[] {
  const out: Finding[] = [];
  for (const entry of problems.console.slice(cursor.console)) {
    if (entry.startsWith('warning:')) continue;
    if (entry.startsWith('log error: Failed to load resource')) continue; // the network detector covers it
    if (entry.startsWith('exception: ')) {
      out.push({ kind: 'page-exception', severity: 4, title: `Uncaught exception: ${clip(entry.slice(11).split('\n')[0]!, 100)}`, detail: clip(entry, 600), ...ctx });
    } else {
      out.push({ kind: 'console-error', severity: 3, title: `Console error: ${clip(entry.replace(/^(error|log error): /, ''), 100)}`, detail: clip(entry, 600), ...ctx });
    }
  }
  if (ctx.offline) return out; // failed requests are expected while the browser is offline
  for (const entry of problems.network.slice(cursor.network)) {
    const m = /^(\d{3}) (\S+)/.exec(entry);
    if (m) {
      const status = Number(m[1]);
      if (/\/favicon\.ico(\?|$)/.test(m[2]!)) continue;
      out.push({ kind: 'http-error', severity: status >= 500 ? 4 : 3, title: `HTTP ${status} ${clip(m[2]!, 100)}`, detail: entry, ...ctx });
    } else {
      out.push({ kind: 'request-failed', severity: 3, title: `Request failed: ${clip(entry, 100)}`, detail: entry, ...ctx });
    }
  }
  return out;
}

/** Interactive elements with no accessible name. Pure. */
export function snapshotFindings(snapshotText: string, ctx: { url: string; step: number }): Finding[] {
  const byRole = new Map<string, number>();
  for (const e of parseSnapshotRefs(snapshotText)) {
    if (e.name.trim() === '') byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1);
  }
  return [...byRole].map(([role, count]) => ({
    kind: 'unnamed-control' as const,
    severity: 2 as const,
    title: `Unnamed ${role}`,
    detail: `${count} ${role} element${count > 1 ? 's have' : ' has'} no accessible name, so screen readers and agents cannot tell what it does.`,
    ...ctx,
  }));
}

export function overflowFinding(
  m: { scrollWidth: number; innerWidth: number },
  ctx: { url: string; step: number },
): Finding | undefined {
  if (!(m.scrollWidth > m.innerWidth + 1)) return undefined;
  return {
    kind: 'horizontal-overflow',
    severity: 2,
    title: `Horizontal overflow at ${m.innerWidth}px viewport`,
    detail: `The page is ${m.scrollWidth}px wide in a ${m.innerWidth}px viewport, so it scrolls sideways.`,
    ...ctx,
  };
}

export type FetchLike = (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;

export interface BrokenLinkOptions {
  cap?: number;
  fetch?: FetchLike;
}

/** Checks up to `cap` same-origin links. Sends no cookies, so authenticated links may report 401/403. */
export async function brokenLinkFindings(
  links: string[],
  origin: string,
  ctx: { url: string; step: number },
  opts: BrokenLinkOptions = {},
): Promise<Finding[]> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const unique = [...new Set(links.map((l) => l.split('#')[0]!))]
    .filter((l) => l && l.startsWith(origin) && l !== ctx.url.split('#')[0])
    .slice(0, opts.cap ?? 20);
  const out: Finding[] = [];
  for (const link of unique) {
    let status = 0;
    try {
      status = (await doFetch(link, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).status;
      if (status === 405 || status === 501) status = (await doFetch(link, { method: 'GET', signal: AbortSignal.timeout(5000) })).status;
    } catch {
      status = 0;
    }
    if (status >= 400 || status === 0) {
      out.push({
        kind: 'broken-link',
        severity: 3,
        title: `Broken link: ${clip(link.slice(origin.length) || '/', 100)}`,
        detail: status === 0 ? `${link} could not be fetched` : `${link} returned ${status}`,
        ...ctx,
      });
    }
  }
  return out;
}

export interface DetectorOptions {
  baseUrl: string;
  /** Opt in to link checking (extra HTTP requests). Default false. */
  checkLinks?: boolean;
  fetch?: FetchLike;
}

/** Stateful runner: remembers how much of the problem log it has seen and dedupes by kind+title. */
export class Detectors {
  private cursor: ProblemCursor = { console: 0, network: 0 };
  private readonly seen = new Set<string>();
  offline = false;

  constructor(private readonly page: Page, private readonly opts: DetectorOptions) {}

  /** Runs every detector and returns only findings not seen before. */
  async run(step: number, snapshotText?: string): Promise<Finding[]> {
    const url = await this.page.url().catch(() => '');
    const ctx = { url, step };
    const problems = this.page.problems();
    const found = problemFindings(problems, this.cursor, { ...ctx, offline: this.offline });
    this.cursor = { console: problems.console.length, network: problems.network.length };

    const text = snapshotText ?? (await this.page.snapshot().then((s) => s.text).catch(() => ''));
    found.push(...snapshotFindings(text, ctx));

    const metrics = await this.page
      .evaluate<{ scrollWidth: number; innerWidth: number }>(
        '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
      )
      .catch(() => undefined);
    const overflow = metrics && overflowFinding(metrics, ctx);
    if (overflow) found.push(overflow);

    if (this.opts.checkLinks && !this.offline) {
      const links = await this.page
        .evaluate<string[]>("Array.from(document.querySelectorAll('a[href]')).map(function(a){return a.href})")
        .catch(() => [] as string[]);
      found.push(...(await brokenLinkFindings(links, new URL(this.opts.baseUrl).origin, ctx, { fetch: this.opts.fetch })));
    }

    return found.filter((f) => {
      const key = `${f.kind}\u0000${f.title}`;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      return true;
    });
  }
}

export const findingKey = (f: { kind: string; title: string }): string => `${f.kind}\u0000${f.title}`;
