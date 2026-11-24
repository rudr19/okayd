// Getting the verifier signed in. Four ways, usable together:
//   storageState  a Playwright-shaped JSON file (cookies + localStorage per origin)
//   cookies       cookies given directly
//   headers       extra HTTP headers on every request
//   login         a module whose default export is `async (page) => void`, run before each criterion
//
// Secrets stay out of everything okproof prints or saves: error messages name
// a file or a position, never a cookie or header value.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '../driver/index.js';

export interface CookieInput {
  name: string;
  value: string;
  /** Without a domain the cookie is scoped to the base URL. */
  domain?: string;
  path?: string;
  /** Seconds since the epoch. -1 or absent means a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface StorageState {
  cookies?: CookieInput[];
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
}

export type LoginHook = (page: Page) => Promise<void>;

export interface AuthOptions {
  /** Path to a storage-state JSON file. */
  storageState?: string;
  cookies?: CookieInput[];
  headers?: Record<string, string>;
  /** Path to a login module, or the function itself. */
  login?: string | LoginHook;
}

export interface PreparedAuth {
  /** True when any of the four options was given. */
  active: boolean;
  /** Applies headers, cookies and localStorage, then runs the login hook. Call once per fresh page, before navigating. */
  apply(page: Page, baseUrl: string): Promise<void>;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_HEADER = '--header must look like \'Name: value\' (a plain header name, then a colon, then the value on one line).';

/** Parses "Name: value". Never repeats the input in its error. */
export function parseHeader(raw: string): [string, string] {
  const colon = raw.indexOf(':');
  if (colon < 1) throw new Error(BAD_HEADER);
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) throw new Error(BAD_HEADER);
  return [name, value];
}

function cookieParams(c: CookieInput, i: number, baseUrl: string): Record<string, unknown> {
  if (typeof c?.name !== 'string' || c.name === '' || typeof c.value !== 'string') throw new Error(`Cookie #${i + 1} needs a name and a string value.`);
  const p: Record<string, unknown> = { name: c.name, value: c.value };
  if (c.domain) {
    p.domain = c.domain;
    p.path = c.path ?? '/';
  } else {
    p.url = baseUrl;
    if (c.path) p.path = c.path;
  }
  if (typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') p.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') p.secure = c.secure;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') p.sameSite = c.sameSite;
  return p;
}

async function readStorageState(path: string): Promise<StorageState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`The storage state file ${path} could not be read.`);
  }
  try {
    const parsed = JSON.parse(text) as StorageState;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    // JSON.parse errors quote the input, which here may hold session tokens.
    throw new Error(`The storage state file ${path} is not valid JSON of the form { cookies: [...], origins: [...] }.`);
  }
}

async function loadLogin(login: string | LoginHook): Promise<LoginHook> {
  if (typeof login === 'function') return login;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(resolve(login)).href)) as { default?: unknown };
  } catch {
    throw new Error(`The login script ${login} could not be loaded.`);
  }
  if (typeof mod.default !== 'function') throw new Error(`The login script ${login} must default-export an async function (page) => void.`);
  return mod.default as LoginHook;
}

/**
 * JSON that is safe to embed in JavaScript source: escapes characters that could
 * end a script, open HTML, or terminate a line (CodeQL js/bad-code-sanitization).
 */
export function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  let out = '';
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    // < > & / and the two Unicode line separators
    if (code === 0x3c || code === 0x3e || code === 0x26 || code === 0x2f || code === 0x2028 || code === 0x2029) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += json[i];
    }
  }
  return out;
}

/** Runs before the page's own scripts on every document, and only once per tab. */
function localStorageScript(origin: string, items: { name: string; value: string }[]): string {
  return `(function(){try{if(location.origin!==${jsLiteral(origin)})return;var m='__okproof_ls';if(sessionStorage.getItem(m))return;sessionStorage.setItem(m,'1');var a=${jsLiteral(items.map((i) => [String(i.name), String(i.value)]))};for(var i=0;i<a.length;i++)localStorage.setItem(a[i][0],a[i][1]);}catch(e){}})();`;
}

/** Reads and validates everything once, so a bad file fails before any browser starts. */
export async function prepareAuth(o: AuthOptions): Promise<PreparedAuth> {
  const state = o.storageState ? await readStorageState(o.storageState) : {};
  const cookies = [...(state.cookies ?? []), ...(o.cookies ?? [])];
  cookies.forEach((c, i) => cookieParams(c, i, 'http://localhost/')); // validate now
  const origins = (state.origins ?? []).filter((x) => typeof x?.origin === 'string' && Array.isArray(x.localStorage) && x.localStorage.length > 0);
  const headers = o.headers && Object.keys(o.headers).length > 0 ? o.headers : undefined;
  if (headers) for (const [k, v] of Object.entries(headers)) parseHeader(`${k}: ${v}`);
  const login = o.login ? await loadLogin(o.login) : undefined;
  return {
    active: cookies.length > 0 || origins.length > 0 || headers !== undefined || login !== undefined,
    async apply(page, baseUrl) {
      if (headers) await page.command('Network.setExtraHTTPHeaders', { headers });
      if (cookies.length > 0) await page.command('Network.setCookies', { cookies: cookies.map((c, i) => cookieParams(c, i, baseUrl)) });
      for (const x of origins) {
        await page.command('Page.addScriptToEvaluateOnNewDocument', { source: localStorageScript(x.origin, x.localStorage!) });
      }
      if (login) await login(page);
    },
  };
}
