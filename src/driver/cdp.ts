// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Flat sessions: every message carries an optional sessionId.

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

type Listener = (params: any, sessionId?: string) => void;

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  static connect(wsUrl: string, timeoutMs = 10000): Promise<Cdp> {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      return Promise.reject(new CdpError('The okproof browser driver needs Node 22 or later (global WebSocket is missing).'));
    }
    return new Promise((resolve, reject) => {
      const ws = new WS(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new CdpError(`Timed out after ${timeoutMs}ms connecting to ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`Could not connect to ${wsUrl}`));
      }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: connection closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(new CdpError(`${method}: ${(e as Error).message}`));
      }
    });
  }

  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const s = set;
    s.add(listener);
    return () => { s.delete(listener); };
  }

  waitFor<T = any>(event: string, sessionId: string | undefined, timeoutMs: number, match?: (params: any) => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.on(event, (params, sid) => {
        if (sessionId !== undefined && sid !== sessionId) return;
        if (match && !match(params)) return;
        clearTimeout(timer);
        off();
        resolve(params as T);
      });
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Timed out after ${timeoutMs}ms waiting for ${event}`));
      }, timeoutMs);
    });
  }

  close(): void {
    this.onClose();
    try { this.ws.close(); } catch { /* ignore */ }
  }

  private onMessage(data: string): void {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const l of [...set]) {
        try { l(msg.params, msg.sessionId); } catch { /* listener errors must not break the pump */ }
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new CdpError(`${p.method}: connection closed`));
    this.pending.clear();
  }
}
