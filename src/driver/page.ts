import { Cdp } from './cdp.js';
import { launchChrome, type LaunchedChrome, type LaunchOptions } from './launch.js';
import { buildSnapshot, type Snapshot } from './snapshot.js';

export interface Problems {
  console: string[];
  network: string[];
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

export class Browser {
  private readonly pages = new Set<Page>();

  private constructor(readonly cdp: Cdp, private readonly chrome: LaunchedChrome) {}

  static async launch(opts: LaunchOptions = {}): Promise<Browser> {
    const chrome = await launchChrome(opts);
    try {
      const cdp = await Cdp.connect(chrome.wsEndpoint, opts.timeoutMs ?? 15000);
      return new Browser(cdp, chrome);
    } catch (e) {
      await chrome.kill();
      throw e;
    }
  }

  get process(): LaunchedChrome['process'] {
    return this.chrome.process;
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.cdp, targetId, sessionId);
    await page.init();
    this.pages.add(page);
    return page;
  }

  async close(): Promise<void> {
    try { this.cdp.close(); } catch { /* ignore */ }
    await this.chrome.kill();
  }
}

export class Page {
  private refs = new Map<string, number>();
  private readonly problemLog: Problems = { console: [], network: [] };
  private readonly requestUrls = new Map<string, string>();

  constructor(private readonly cdp: Cdp, readonly targetId: string, readonly sessionId: string) {}

  /** Enables the domains the driver needs and starts collecting problems. */
  async init(): Promise<void> {
    const s = this.sessionId;
    this.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== s || (p.type !== 'error' && p.type !== 'warning')) return;
      const text = (p.args ?? []).map((a: any) => a.value !== undefined ? String(a.value) : a.description ?? a.type).join(' ');
      this.problemLog.console.push(`${p.type}: ${text}`);
    });
    this.cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== s) return;
      const d = p.exceptionDetails ?? {};
      this.problemLog.console.push(`exception: ${d.exception?.description ?? d.text ?? 'unknown'}`);
    });
    this.cdp.on('Log.entryAdded', (p, sid) => {
      if (sid !== s || p.entry?.level !== 'error') return;
      this.problemLog.console.push(`log error: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
    });
    this.cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (sid === s) this.requestUrls.set(p.requestId, p.request?.url);
    });
    this.cdp.on('Network.loadingFailed', (p, sid) => {
      if (sid !== s || p.canceled) return;
      this.problemLog.network.push(`${this.requestUrls.get(p.requestId) ?? p.requestId} ${p.errorText}`);
    });
    this.cdp.on('Network.responseReceived', (p, sid) => {
      if (sid !== s || !(p.response?.status >= 400)) return;
      this.problemLog.network.push(`${p.response.status} ${p.response.url}`);
    });
    await Promise.all([
      this.cdp.send('Runtime.enable', {}, s),
      this.cdp.send('Log.enable', {}, s),
      this.cdp.send('Network.enable', {}, s),
      this.cdp.send('Page.enable', {}, s),
    ]);
  }

  private send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async goto(url: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30000;
    await this.send('Page.enable');
    const loaded = this.cdp.waitFor('Page.loadEventFired', this.sessionId, timeoutMs);
    loaded.catch(() => { /* handled below */ });
    const res = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (res.errorText) throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
    await loaded;
    this.refs = new Map();
  }

  async reload(opts: { timeoutMs?: number } = {}): Promise<void> {
    const loaded = this.cdp.waitFor('Page.loadEventFired', this.sessionId, opts.timeoutMs ?? 30000);
    loaded.catch(() => { /* handled below */ });
    await this.send('Page.reload');
    await loaded;
    this.refs = new Map();
  }

  /** Goes back one history entry. Returns false when there is nothing to go back to. */
  async back(): Promise<boolean> {
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const prev = h.entries[h.currentIndex - 1];
    if (!prev) return false;
    // A page restored from the back/forward cache fires no load event, so do not insist on one.
    const loaded = this.cdp.waitFor('Page.loadEventFired', this.sessionId, 3000);
    loaded.catch(() => { /* bfcache restore */ });
    await this.send('Page.navigateToHistoryEntry', { entryId: prev.id });
    await loaded.catch(() => undefined);
    this.refs = new Map();
    return true;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  async snapshot(): Promise<Snapshot> {
    await this.send('Accessibility.enable');
    const { nodes } = await this.send<{ nodes: any[] }>('Accessibility.getFullAXTree');
    const snap = buildSnapshot(nodes);
    this.refs = snap.refs;
    return snap;
  }

  private backendId(ref: string): number {
    const id = this.refs.get(ref);
    if (id === undefined) throw new Error(`Unknown ref ${ref}; take a new snapshot`);
    return id;
  }

  async click(ref: string): Promise<void> {
    const backendNodeId = this.backendId(ref);
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => { /* may fail for already visible */ });
    let x: number, y: number;
    try {
      const { quads } = await this.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId });
      const q = quads.find((c) => c.length >= 8);
      if (!q) throw new Error('no quads');
      x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
      y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    } catch {
      throw new Error(`Cannot click ${ref}: element has no visible box`);
    }
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  async type(ref: string, text: string): Promise<void> {
    await this.send('DOM.focus', { backendNodeId: this.backendId(ref) });
    await this.send('Input.insertText', { text });
  }

  async press(key: string): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new Error(`Unsupported key "${key}". Supported: ${Object.keys(KEYS).join(', ')}`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.send('Input.dispatchKeyEvent', k.text ? { ...base, type: 'keyDown', text: k.text } : { ...base, type: 'rawKeyDown' });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<any>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate failed: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value as T;
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  problems(): Problems {
    return { console: [...this.problemLog.console], network: [...this.problemLog.network] };
  }

  async close(): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => { /* already gone */ });
  }
}
