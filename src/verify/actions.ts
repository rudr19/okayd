// The action vocabulary. Actions are plain JSON so a run can be saved and
// replayed with no model. Refs change with every snapshot, so click/type also
// record the element's role and accessible name; replay resolves by those.

import type { Page } from '../driver/index.js';

export interface Target {
  role: string;
  name: string;
  /** Index among elements with the same role and name, in snapshot order. */
  nth: number;
}

export type Action =
  | { type: 'goto'; url: string }
  | ({ type: 'click'; ref?: string } & Target)
  | ({ type: 'type'; ref?: string; text: string } & Target)
  | { type: 'press'; key: string }
  | { type: 'setViewport'; width: number; height: number }
  | { type: 'reload' }
  | { type: 'back' }
  | { type: 'offline'; on: boolean }
  | { type: 'assertText'; text: string; present: boolean }
  | { type: 'assertUrl'; includes: string }
  | { type: 'assertNoProblems' };

export const ASSERTIONS = new Set<Action['type']>(['assertText', 'assertUrl', 'assertNoProblems']);
export const isAssertion = (a: Action): boolean => ASSERTIONS.has(a.type);

export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  nth: number;
}

// Three linear regexes instead of one with a lazy wildcard, which could run in
// polynomial time on crafted input (CodeQL js/polynomial-redos).
const LINE_ROLE = /^\s*- (\S+)/;
const LINE_NAME = /^\s*- \S+ ("(?:[^"\\]|\\.)*")/;
const LINE_REF = /\[ref=(e\d+)\]/;
const REF_LINE = {
  exec(line: string): [string, string, string | undefined, string] | null {
    const role = LINE_ROLE.exec(line);
    const ref = LINE_REF.exec(line);
    if (!role || !ref) return null;
    return [line, role[1]!, LINE_NAME.exec(line)?.[1], ref[1]!];
  },
};

/** Reads every interactive element out of snapshot text, with its role, name and nth. */
export function parseSnapshotRefs(text: string): RefEntry[] {
  const seen = new Map<string, number>();
  const out: RefEntry[] = [];
  for (const line of text.split('\n')) {
    const m = REF_LINE.exec(line);
    if (!m) continue;
    const role = m[1]!;
    let name = '';
    if (m[2]) {
      try { name = JSON.parse(m[2]) as string; } catch { name = m[2].slice(1, -1); }
    }
    const key = `${role}\u0000${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    out.push({ ref: m[3]!, role, name, nth });
  }
  return out;
}

export function describeTarget(t: Target): string {
  return `${t.role} ${JSON.stringify(t.name)}${t.nth > 0 ? ` #${t.nth + 1}` : ''}`;
}

export interface ExecResult {
  /** False when the action itself could not run (element missing, navigation failed). */
  ran: boolean;
  error?: string;
  /** Set for assertions: whether it held. */
  passed?: boolean;
  /** Set for failed assertions: what was observed. */
  message?: string;
}

export interface ExecContext {
  baseUrl: string;
  /** Live mode trusts action.ref from the latest snapshot; replay resolves by role+name. */
  resolveByLabel: boolean;
}

/** Stores same-origin URLs as paths so a repro is portable between environments. */
export function normalizeUrl(url: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const u = new URL(url, base);
  return u.origin === base.origin ? u.pathname + u.search + u.hash : u.href;
}

async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const state = await page.evaluate<string>('document.readyState').catch(() => 'loading');
    if (state === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 250));
}

/** Text a user can see: rendered text plus the values of form fields. */
const PAGE_TEXT =
  "(document.body ? document.body.innerText : '') + '\\n' + " +
  "Array.from(document.querySelectorAll('input,textarea,select')).map(function(e){return e.value}).join('\\n')";

export async function pageText(page: Page): Promise<string> {
  return page.evaluate<string>(PAGE_TEXT);
}

function resolveRef(entries: RefEntry[], t: Target): string | undefined {
  return entries.find((e) => e.role === t.role && e.name === t.name && e.nth === t.nth)?.ref;
}

/** Runs one action. Never throws for ordinary failures: they come back in the result. */
export async function execute(page: Page, action: Action, ctx: ExecContext): Promise<ExecResult> {
  try {
    switch (action.type) {
      case 'goto':
        await page.goto(new URL(action.url, ctx.baseUrl).href);
        await settle(page);
        return { ran: true };
      case 'click':
      case 'type': {
        let ref = ctx.resolveByLabel ? undefined : action.ref;
        if (!ref) {
          const entries = parseSnapshotRefs((await page.snapshot()).text);
          ref = resolveRef(entries, action);
          if (!ref) return { ran: false, error: `No ${describeTarget(action)} on the page` };
        }
        if (action.type === 'click') await page.click(ref);
        else await page.type(ref, action.text);
        await settle(page);
        return { ran: true };
      }
      case 'press':
        await page.press(action.key);
        await settle(page);
        return { ran: true };
      case 'setViewport':
        await page.setViewport(action.width, action.height);
        await settle(page);
        return { ran: true };
      case 'reload':
        await page.reload();
        await settle(page);
        return { ran: true };
      case 'back': {
        const moved = await page.back();
        await settle(page);
        return moved ? { ran: true } : { ran: false, error: 'No earlier history entry to go back to' };
      }
      case 'offline':
        await page.setOffline(action.on);
        return { ran: true };
      case 'assertText': {
        const found = (await pageText(page)).includes(action.text);
        const passed = found === action.present;
        return {
          ran: true,
          passed,
          message: passed ? undefined : `expected text ${JSON.stringify(action.text)} to be ${action.present ? 'present' : 'absent'}, but it was ${found ? 'present' : 'absent'}`,
        };
      }
      case 'assertUrl': {
        const url = await page.url();
        const passed = url.includes(action.includes);
        return { ran: true, passed, message: passed ? undefined : `expected URL to include ${JSON.stringify(action.includes)}, got ${url}` };
      }
      case 'assertNoProblems': {
        const p = page.problems();
        const all = [...p.console.filter((c) => !c.startsWith('warning:')), ...p.network];
        const passed = all.length === 0;
        return { ran: true, passed, message: passed ? undefined : `page problems: ${all.slice(0, 5).join(' | ')}` };
      }
    }
  } catch (e) {
    return { ran: false, error: (e as Error).message };
  }
}
