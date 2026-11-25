// The zero-token probe library: deterministic attacks that run with no model.
// Each probe drives the page through the same actions a model would use and ends
// in an assertion that FAILS when the bug is present. Everything a probe does is
// recorded as plain actions, so the existing model-free replay confirms it in a
// fresh browser exactly as it confirms a model's claim.

import { Browser, type Page, type WaitUntil } from '../driver/index.js';
import { execute, isAssertion, normalizeUrl, parseSnapshotRefs, type Action, type RefEntry } from './actions.js';
import type { Violation } from './agent.js';
import { attributeFinding } from './attribution.js';
import type { PreparedAuth } from './auth.js';
import { XSS_PAYLOAD } from './checks.js';
import { Detectors, findingKey, REFUTE_SEVERITY, type Finding } from './detectors.js';
import { INSPECT_SCRIPT, type InspectResult } from './probe-dom.js';
import { freshReplay } from './run.js';
import type { ResultFinding } from './types.js';

export type ProbeId = 'persistence' | 'back-forward' | 'double-submit' | 'narrow-viewport' | 'keyboard' | 'offline' | 'hostile-input';

export interface Probe {
  id: ProbeId;
  title: string;
  /** What a confirmed finding from this probe is worth. 3 and above refutes a criterion. */
  severity: 3 | 4 | 5;
  /** Words or phrases in a criterion that make this probe relevant. */
  keywords: string[];
  /** One line for docs and logs: what it catches. */
  catches: string;
  /** Detector findings (after the first page load) worth keeping from this probe's run. */
  keep?: (f: Finding) => boolean;
  run(s: ProbeSession): Promise<void>;
}

const MARKER_PREFIX = 'okproof';
const SUCCESS_WORDS = ['saved', 'success', 'added', 'created', 'updated', 'submitted', 'stored', 'thank you', 'thanks'];
const VIEWPORT = { width: 375, height: 812 };

/** A recording session over one live page. */
export class ProbeSession {
  readonly actions: Action[] = [];
  readonly violations: Violation[] = [];
  readonly findings: Finding[] = [];
  /** Why the probe could not run on this app (no form, no link, ...). Empty when it ran. */
  note = '';
  private readonly detectors: Detectors | undefined;
  private marks = 0;

  constructor(readonly page: Page, readonly baseUrl: string, private readonly probe: Probe) {
    this.detectors = probe.keep ? new Detectors(page, { baseUrl }) : undefined;
  }

  /** A fresh text nobody else has typed, stable across the live run and its replay. */
  marker(): string {
    return `${MARKER_PREFIX}${Date.now().toString(36)}${(++this.marks).toString(36)}`;
  }

  /** Runs and records one action. Returns false, recording nothing, when it could not run. */
  async step(a: Action): Promise<boolean> {
    const r = await execute(this.page, a, { baseUrl: this.baseUrl, resolveByLabel: true });
    if (!r.ran) {
      this.note ||= r.error ?? 'an action could not run';
      return false;
    }
    this.actions.push(a);
    if (a.type === 'offline' && this.detectors) this.detectors.offline = a.on;
    if (this.detectors) {
      const step = this.actions.length - 1;
      // step 0 is the first page load: whatever is wrong there is not this probe's doing.
      for (const f of await this.detectors.run(step, '')) if (step >= 1 && this.probe.keep!(f)) this.findings.push(f);
    }
    return true;
  }

  /** Runs an assertion and records it. If it fails, that is a violation (the bug is present). */
  async claim(v: { title: string; expected: string; actual?: string }, check: Action): Promise<boolean> {
    if (!isAssertion(check)) throw new Error('claim needs an assertion');
    const r = await execute(this.page, check, { baseUrl: this.baseUrl, resolveByLabel: true });
    if (!r.ran) {
      this.note ||= r.error ?? 'an assertion could not run';
      return false;
    }
    this.actions.push(check);
    if (r.passed !== false) return false;
    const index = this.actions.length - 1;
    const actual = v.actual ?? r.message ?? '';
    this.violations.push({ title: v.title, expected: v.expected, actual, assertIndex: index, liveMessage: r.message ?? '' });
    this.findings.push({
      kind: 'violation',
      severity: this.probe.severity,
      title: v.title,
      detail: `expected: ${v.expected}\nactual: ${actual}`,
      url: await this.page.url().catch(() => ''),
      step: index,
    });
    return true;
  }

  /** Opens the app's start page and looks around. */
  async start(): Promise<InspectResult | undefined> {
    if (!(await this.step({ type: 'goto', url: normalizeUrl(this.baseUrl, this.baseUrl) }))) return undefined;
    return this.inspect();
  }

  inspect(): Promise<InspectResult> {
    return this.page.evaluate<InspectResult>(INSPECT_SCRIPT);
  }

  async entries(): Promise<RefEntry[]> {
    return parseSnapshotRefs((await this.page.snapshot()).text);
  }

  async currentPath(): Promise<string> {
    return normalizeUrl(await this.page.url(), this.baseUrl);
  }
}

const target = (e: RefEntry): { role: string; name: string; nth: number } => ({ role: e.role, name: e.name, nth: e.nth });
const isTextbox = (e: RefEntry): boolean => e.role === 'textbox' || e.role === 'searchbox';

/** The first button the page's own markup says submits something, as a snapshot target. */
function submitTarget(entries: RefEntry[], info: InspectResult): RefEntry | undefined {
  for (const name of info.submits) {
    const hit = entries.find((e) => e.role === 'button' && e.name === name);
    if (hit) return hit;
  }
  return undefined;
}

async function fillForm(s: ProbeSession, boxes: RefEntry[], text: string): Promise<boolean> {
  for (const b of boxes.slice(0, 3)) if (!(await s.step({ type: 'type', text, ...target(b) }))) return false;
  return true;
}

const persistence: Probe = {
  id: 'persistence',
  title: 'Saved data is lost after reload',
  severity: 4,
  keywords: ['save', 'saved', 'saves', 'saving', 'persist', 'persists', 'persisted', 'persistence', 'reload', 'reloaded', 'reloading', 'refresh', 'refreshed', 'still there', 'stored', 'remember', 'remembered', 'retained', 'durable'],
  catches: 'a form that says it saved but the data is gone after a fresh page load',
  async run(s) {
    const info = await s.start();
    if (!info) return;
    const entries = await s.entries();
    const boxes = entries.filter(isTextbox);
    const submit = submitTarget(entries, info);
    if (boxes.length === 0 || !submit) { s.note = 'no form with a text field and a submit button'; return; }
    const marker = s.marker();
    const before = (await s.page.evaluate<string>('document.body ? document.body.innerText : ""')).toLowerCase();
    if (!(await fillForm(s, boxes, marker)) || !(await s.step({ type: 'click', ...target(submit) }))) return;
    const after = (await s.page.evaluate<string>('document.body ? document.body.innerText : ""')).toLowerCase();
    const listed = await s.page.evaluate<boolean>(
      `Array.prototype.some.call(document.querySelectorAll('li,tr,[role=listitem],[role=row]'),function(e){return (e.innerText||'').indexOf(${JSON.stringify(marker)})>=0})`,
    );
    const accepted = listed || SUCCESS_WORDS.some((w) => after.includes(w) && !before.includes(w));
    if (!accepted) { s.note = 'the app gave no sign it accepted the input, so there is nothing to expect after a reload'; return; }
    // A fresh navigation, not Reload: Chrome restores typed form values on reload, which would hide the bug.
    if (!(await s.step({ type: 'goto', url: await s.currentPath() }))) return;
    await s.claim(
      { title: this.title, expected: 'what the app accepted is still there after loading the page again', actual: `the app accepted ${JSON.stringify(marker)} but it is not on the page after a fresh load` },
      { type: 'assertText', text: marker, present: true },
    );
  },
};

const backForward: Probe = {
  id: 'back-forward',
  title: 'Back does not restore the previous page',
  severity: 3,
  keywords: ['back button', 'go back', 'goes back', 'going back', 'browser back', 'history', 'back forward', 'back and forward', 'navigate back'],
  catches: 'following a link and pressing Back lands on a different URL, a blank page or a page that lost its content',
  keep: (f) => f.kind === 'page-exception',
  async run(s) {
    const info = await s.start();
    if (!info) return;
    const seen = new Set<string>();
    const links = info.links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 3);
    if (links.length === 0) { s.note = 'no same-origin link to follow'; return; }
    let first = true;
    for (const l of links) {
      if (!first && !(await s.step({ type: 'goto', url: info.path }))) return;
      first = false;
      if (!(await s.step({ type: 'click', role: 'link', name: l.name, nth: l.nth }))) { s.note = ''; continue; }
      if ((await s.currentPath()) === info.path) continue; // the link did not navigate, so there is nothing to go back from
      if (!(await s.step({ type: 'back' }))) continue;
      await s.claim(
        { title: `${this.title} (after following ${l.href})`, expected: 'going back returns to the page you left, with its content' },
        { type: 'assertCheck', check: { kind: 'backRestored', path: info.path, heading: info.heading || undefined } },
      );
    }
  },
};

const doubleSubmit: Probe = {
  id: 'double-submit',
  title: 'Double click submits twice',
  severity: 3,
  keywords: ['submit', 'submits', 'submitted', 'submission', 'form', 'forms', 'order', 'orders', 'ordered', 'checkout', 'duplicate', 'duplicates', 'duplicated', 'twice', 'double click', 'double submit'],
  catches: 'a fast double click on a submit button that sends the request twice or lists the item twice',
  async run(s) {
    const info = await s.start();
    if (!info) return;
    const entries = await s.entries();
    const buttons = info.submits.map((n) => entries.find((e) => e.role === 'button' && e.name === n)).filter((e): e is RefEntry => !!e);
    if (buttons.length === 0) { s.note = 'no submit button'; return; }
    const boxes = entries.filter(isTextbox);
    let first = true;
    for (const submit of buttons) {
      if (!first && !(await s.step({ type: 'goto', url: info.path }))) return;
      first = false;
      const marker = boxes.length > 0 ? s.marker() : '';
      if (marker && !(await fillForm(s, boxes, marker))) return;
      if (!(await s.step({ type: 'dblclick', ...target(submit) }))) return;
      await s.claim(
        { title: `${this.title} (${JSON.stringify(submit.name)})`, expected: 'one click-pair is one submission' },
        { type: 'assertCheck', check: { kind: 'singleSubmit', marker } },
      );
    }
  },
};

const narrowViewport: Probe = {
  id: 'narrow-viewport',
  title: 'Page does not fit a 375px phone screen',
  severity: 3,
  keywords: ['mobile', 'phone', 'phones', 'responsive', 'viewport', 'narrow', 'small screen', '375', '375px', '375 px'],
  catches: 'horizontal scrolling at 375px, and controls that collapse to zero size or slide off screen',
  async run(s) {
    const info = await s.start();
    if (!info) return;
    if (!(await s.step({ type: 'setViewport', ...VIEWPORT }))) return;
    await s.claim(
      { title: this.title, expected: 'the page fits a 375px-wide screen with every control usable' },
      { type: 'assertCheck', check: { kind: 'fitsViewport', names: info.controls } },
    );
  },
};

const keyboard: Probe = {
  id: 'keyboard',
  title: 'Controls cannot be reached with the keyboard',
  severity: 3,
  keywords: ['keyboard', 'accessible', 'accessibility', 'a11y', 'tab key', 'tabbing', 'tab order', 'focus'],
  catches: 'clickable things Tab never lands on (a div with an onclick, tabindex=-1) and focus with no visible indicator',
  async run(s) {
    if (!(await s.start())) return;
    await s.claim(
      { title: this.title, expected: 'every control can be reached by pressing Tab' },
      { type: 'assertCheck', check: { kind: 'tabReachable' } },
    );
    await s.claim(
      { title: 'Focused controls show no visible focus indicator', expected: 'the focused control looks different from the others' },
      { type: 'assertCheck', check: { kind: 'focusVisible' } },
    );
  },
};

const DESTRUCTIVE = ['delete', 'remove', 'cancel', 'logout', 'log out', 'sign out', 'unsubscribe', 'reset', 'clear', 'deactivate'];

const offline: Probe = {
  id: 'offline',
  title: 'Page breaks when the network is lost',
  severity: 3,
  keywords: ['offline', 'no network', 'lose connection', 'loses connection', 'lost connection', 'connection lost', 'network failure', 'network error'],
  catches: 'using the app after the connection drops throws uncaught errors or leaves a blank page instead of a message',
  keep: (f) => f.kind === 'page-exception',
  async run(s) {
    if (!(await s.start())) return;
    const buttons = (await s.entries()).filter((e) => e.role === 'button' && e.name && !DESTRUCTIVE.some((d) => e.name.toLowerCase().includes(d))).slice(0, 3);
    if (buttons.length === 0) { s.note = 'no button to use while offline'; return; }
    if (!(await s.step({ type: 'offline', on: true }))) return;
    for (const b of buttons) await s.step({ type: 'click', ...target(b) });
    await s.claim(
      { title: this.title, expected: 'losing the network leaves a usable page, not a blank one' },
      { type: 'assertCheck', check: { kind: 'notBlank' } },
    );
  },
};

const HOSTILE = [
  { name: 'empty', text: '' },
  { name: '10,000-character', text: 'A'.repeat(10000) },
  { name: 'unicode, right-to-left and emoji', text: 'Ünïcödé עברית مرحبا 😀 👨‍👩‍👧 ‮abc' },
  { name: '<script> markup', text: XSS_PAYLOAD },
];

const hostileInput: Probe = {
  id: 'hostile-input',
  title: 'Hostile input breaks the page',
  severity: 4,
  keywords: ['input', 'inputs', 'form', 'forms', 'field', 'fields', 'validate', 'validates', 'validated', 'validation', 'sanitize', 'sanitizes', 'sanitized', 'escape', 'escapes', 'escaped', 'xss', 'special characters', 'injection', 'invalid'],
  catches: 'empty, 10k-character, unicode and <script> input that crashes the page, causes a 5xx, or comes back as live markup (XSS)',
  keep: (f) => f.kind === 'page-exception' || (f.kind === 'http-error' && f.severity >= 4),
  async run(s) {
    const info = await s.start();
    if (!info) return;
    const entries = await s.entries();
    const boxes = entries.filter(isTextbox);
    if (boxes.length === 0) { s.note = 'no text field'; return; }
    const submit = submitTarget(entries, info);
    let first = true;
    for (const h of HOSTILE) {
      if (!first && !(await s.step({ type: 'goto', url: info.path }))) return;
      first = false;
      if (!(await fillForm(s, boxes, h.text))) return;
      const sent = submit ? await s.step({ type: 'click', ...target(submit) }) : await s.step({ type: 'press', key: 'Enter' });
      if (!sent) return;
      await s.claim(
        { title: `Page goes blank after ${h.name} input`, expected: 'hostile input is handled and the page stays usable' },
        { type: 'assertCheck', check: { kind: 'notBlank' } },
      );
      if (h.text === XSS_PAYLOAD) {
        await s.claim(
          { title: 'Hostile input is rendered unescaped (XSS)', expected: 'submitted text is shown as text, never as markup or script' },
          { type: 'assertCheck', check: { kind: 'escaped' } },
        );
      }
    }
  },
};

export const PROBES: readonly Probe[] = [persistence, backForward, doubleSubmit, narrowViewport, keyboard, offline, hostileInput];

export const probeById = (id: string): Probe | undefined => PROBES.find((p) => p.id === id);

function words(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) cur += ch;
    else if (cur) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

function hasPhrase(tokens: string[], phrase: string[]): boolean {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let j = 0;
    while (j < phrase.length && tokens[i + j] === phrase[j]) j++;
    if (j === phrase.length) return true;
  }
  return false;
}

/** The probes whose keywords appear in a criterion. Whole words only, so "format" does not match "form". */
export function matchProbes(criterion: string): Probe[] {
  const tokens = words(criterion);
  return PROBES.filter((p) => p.keywords.some((k) => hasPhrase(tokens, words(k))));
}

export interface ProbeResult {
  id: ProbeId;
  title: string;
  /** False when the app has nothing for this probe to act on (or the probe could not run). */
  applicable: boolean;
  note?: string;
  error?: string;
  actions: Action[];
  violations: Violation[];
  findings: ResultFinding[];
  screenshots: string[];
  /** A confirmed finding at or above the refute severity. */
  refuted: boolean;
}

export interface RunProbeOptions {
  baseUrl: string;
  chrome?: string;
  auth?: PreparedAuth;
  waitUntil?: WaitUntil;
  /** Where screenshots of confirmed failures go. */
  screenshotDir?: string;
  strictDetectors?: boolean;
}

/** Runs one probe in a fresh browser, then confirms whatever it found by replaying in another. */
export async function runProbe(probe: Probe, o: RunProbeOptions): Promise<ProbeResult> {
  const base: ProbeResult = { id: probe.id, title: probe.title, applicable: false, actions: [], violations: [], findings: [], screenshots: [], refuted: false };
  const browser = await Browser.launch({ executablePath: o.chrome, waitUntil: o.waitUntil });
  let session: ProbeSession;
  try {
    const page = await browser.newPage();
    await o.auth?.apply(page, o.baseUrl);
    session = new ProbeSession(page, o.baseUrl, probe);
    try {
      await probe.run(session);
    } catch (e) {
      return { ...base, error: (e as Error).message, actions: session.actions };
    }
  } finally {
    await browser.close();
  }
  const ran = session.actions.length > 0 && (session.violations.length > 0 || session.findings.length > 0 || session.note === '');
  if (session.violations.length === 0 && session.findings.length === 0) {
    return { ...base, applicable: ran, note: session.note || undefined, actions: session.actions };
  }
  const fr = await freshReplay(session.actions, {
    baseUrl: o.baseUrl,
    chrome: o.chrome,
    auth: o.auth,
    waitUntil: o.waitUntil,
    screenshotDir: o.screenshotDir,
    screenshotPrefix: `probe-${probe.id}`,
  });
  const replayed = new Set(fr.result.findings.map(findingKey));
  const findings: ResultFinding[] = session.findings.map((f) => {
    const confirmed =
      f.kind === 'violation'
        ? session.violations.some((v) => v.assertIndex === f.step && v.title === f.title && fr.result.assertionFailed.get(v.assertIndex) === true)
        : replayed.has(findingKey(f));
    return { ...attributeFinding(f, { baseUrl: o.baseUrl, strict: o.strictDetectors }), confirmed };
  });
  return {
    ...base,
    applicable: true,
    actions: session.actions,
    violations: session.violations,
    findings,
    screenshots: fr.screenshots,
    refuted: findings.some((f) => f.confirmed && !f.downgraded && f.severity >= REFUTE_SEVERITY),
  };
}
