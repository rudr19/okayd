// Deterministic page checks used as assertions by probes. Each one is plain JSON
// (a CheckSpec) so a probe's run can be saved and replayed with no model. A check
// PASSES when the page is fine and FAILS when the bug is present, exactly like
// the assertions a model supplies.

import type { Page } from '../driver/index.js';
import { DOM_HELPERS } from './probe-dom.js';

export type CheckSpec =
  | { kind: 'fitsViewport'; names: string[] }
  | { kind: 'tabReachable' }
  | { kind: 'focusVisible' }
  | { kind: 'escaped' }
  | { kind: 'notBlank' }
  | { kind: 'backRestored'; path: string; heading?: string }
  | { kind: 'singleSubmit'; marker: string };

export interface CheckResult {
  passed: boolean;
  message?: string;
}

/** Injected as hostile input: if it comes back as live markup or runs, the page does not escape output. */
export const XSS_PAYLOAD = '<i id="okproof-xss">okproof-xss</i><script>window.__okproofXss=1</script>';

const ok: CheckResult = { passed: true };
const fail = (message: string): CheckResult => ({ passed: false, message });
const clip = (s: string, n = 200): string => (s.length > n ? s.slice(0, n) + '…' : s);

export function describeCheck(c: CheckSpec): string {
  return c.kind;
}

export async function runCheck(page: Page, c: CheckSpec): Promise<CheckResult> {
  switch (c.kind) {
    case 'fitsViewport': return fitsViewport(page, c.names);
    case 'tabReachable': return keyboard(page, 'reach');
    case 'focusVisible': return keyboard(page, 'focus');
    case 'escaped': return escaped(page);
    case 'notBlank': return notBlank(page);
    case 'backRestored': return backRestored(page, c.path, c.heading);
    case 'singleSubmit': return singleSubmit(page, c.marker);
  }
}

async function fitsViewport(page: Page, names: string[]): Promise<CheckResult> {
  const problems = await page.evaluate<string[]>(`(function(names){${DOM_HELPERS}
var problems=[], de=document.documentElement;
if(de.scrollWidth>window.innerWidth+1) problems.push('the page is '+de.scrollWidth+'px wide in a '+window.innerWidth+'px viewport, so it scrolls sideways');
var by={};
Array.prototype.forEach.call(document.querySelectorAll('button,a[href],input,select,textarea,[role=button]'),function(e){
  if(e.tagName==='INPUT'&&e.type==='hidden') return;
  var n=okpName(e); if(!n) return; (by[n]=by[n]||[]).push(e);
});
names.forEach(function(n){
  var list=by[n]; if(!list) return;
  var usable=false, bad=null;
  list.forEach(function(e){
    var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') return;
    var r=e.getBoundingClientRect();
    if(r.width>=1&&r.height>=1&&r.left<window.innerWidth&&r.right>0){usable=true;return}
    if(okpMoved(e)){usable=true;return}
    bad=bad||((r.width<1||r.height<1)?'has zero size':'sits off the edge of the screen');
  });
  if(!usable&&bad) problems.push('"'+n+'" '+bad);
});
return problems;
})(${JSON.stringify(names)})`);
  return problems.length === 0 ? ok : fail(clip(problems.slice(0, 5).join('; ')));
}

async function escaped(page: Page): Promise<CheckResult> {
  const hit = await page.evaluate<string>(
    `(function(){ if(window.__okproofXss===1) return 'the injected script ran'; ` +
    `if(document.getElementById('okproof-xss')) return 'the injected markup became a live element'; return ''; })()`,
  );
  return hit ? fail(`hostile input was rendered unescaped: ${hit}`) : ok;
}

async function notBlank(page: Page): Promise<CheckResult> {
  const text = await page.evaluate<string>(`document.body ? document.body.innerText.trim() : ''`);
  const hasMedia = await page.evaluate<boolean>(`!!(document.body && document.body.querySelector('img,svg,canvas,video,input,button'))`);
  return text.length > 0 || hasMedia ? ok : fail('the page is blank (no text and no controls)');
}

async function backRestored(page: Page, path: string, heading?: string): Promise<CheckResult> {
  const here = await page.evaluate<string>('location.pathname + location.search');
  if (here !== path) return fail(`after going back the URL is ${here}, expected ${path}`);
  const text = await page.evaluate<string>(`document.body ? document.body.innerText : ''`);
  if (text.trim().length === 0) return fail('after going back the page is blank');
  if (heading && !text.includes(heading)) return fail(`after going back the page no longer shows its heading ${JSON.stringify(heading)}`);
  return ok;
}

async function singleSubmit(page: Page, marker: string): Promise<CheckResult> {
  // Without a marker (a button-only page) any identical write sent twice counts.
  const sent = page.requests().filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'OPTIONS' && (marker === '' || (r.postData ?? '').includes(marker) || r.url.includes(marker)));
  const groups = new Map<string, number>();
  for (const r of sent) groups.set(`${r.method} ${r.url} ${r.postData ?? ''}`, (groups.get(`${r.method} ${r.url} ${r.postData ?? ''}`) ?? 0) + 1);
  const worst = [...groups].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 2) return fail(`a double click sent the same request ${worst[1]} times (${clip(worst[0].split(' ').slice(0, 2).join(' '), 90)})`);
  if (marker === '') return ok;
  const rows = await page.evaluate<number>(`(function(m){
var items=Array.prototype.filter.call(document.querySelectorAll('li,tr,[role=listitem],[role=row],article'),function(e){return (e.innerText||'').indexOf(m)>=0});
return items.filter(function(e){return !items.some(function(o){return o!==e&&e.contains(o)})}).length;
})(${JSON.stringify(marker)})`);
  return rows >= 2 ? fail(`a double click created ${rows} list items for the same submission`) : ok;
}

const SETUP_KEYBOARD = `(function(){${DOM_HELPERS}
var SEL='a[href],button,input,select,textarea,summary,[tabindex],[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[role=switch],[onclick]';
var ROVING='[role=tablist],[role=menu],[role=menubar],[role=listbox],[role=radiogroup],[role=toolbar],[role=grid],[role=tree],[role=treegrid]';
var WIDGET={button:1,link:1,checkbox:1,menuitem:1,tab:1,'switch':1};
var cand=[], radios={};
Array.prototype.forEach.call(document.querySelectorAll(SEL),function(e){
  if(e.tagName==='INPUT'&&e.type==='hidden') return;
  if(e.disabled||e.closest('[inert],[aria-hidden=true],fieldset[disabled]')) return;
  if(!okpShown(e)||e.closest(ROVING)) return;
  var ti=e.getAttribute('tabindex'), neg=ti!==null&&parseInt(ti,10)<0;
  var native=/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.tagName)||(e.tagName==='A'&&e.hasAttribute('href'));
  var label=okpName(e)||e.tagName.toLowerCase(), reason='';
  if(e.tagName==='INPUT'&&e.type==='radio'){var k=e.name||''; if(radios[k]) return; radios[k]=1;}
  if(native){ if(neg) reason='tabindex=-1'; }
  else {
    var role=e.getAttribute('role'), interactive=!!(role&&WIDGET[role])||e.hasAttribute('onclick');
    if(ti!==null&&!neg) { /* focusable by construction */ }
    else {
      if(!interactive) return;
      if(e.parentElement&&e.parentElement.closest('a[href],button,[role=button],[role=link]')) return;
      if(e.querySelector('a[href],button,input,select,textarea,[tabindex]')) return;
      if(!okpName(e)||okpName(e).length>80) return;
      reason='not focusable (no tabindex)';
    }
  }
  cand.push({el:e,label:(role?role+' ':'')+JSON.stringify(label).slice(0,60),reason:reason});
});
window.__okpKb={cand:cand,reached:[]};
if(document.activeElement&&document.activeElement.blur) document.activeElement.blur();
var b=document.body; var had=b.getAttribute('tabindex'); b.setAttribute('tabindex','-1'); b.focus();
if(had===null) b.removeAttribute('tabindex'); else b.setAttribute('tabindex',had);
return cand.length;
})()`;

const SAMPLE_KEYBOARD = `(function(){${DOM_HELPERS}
var a=document.activeElement; if(!a||a===document.body||a===document.documentElement) return {end:true};
var K=window.__okpKb; if(K.reached.indexOf(a)>=0) return {repeat:true};
K.reached.push(a);
function sig(e){var s=getComputedStyle(e);return [s.outlineStyle,s.outlineWidth,s.outlineColor,s.boxShadow,s.borderTopColor,s.borderTopWidth,s.backgroundColor,s.color,s.textDecorationLine,s.transform,s.filter].join('|')}
var s=getComputedStyle(a), vis=s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0;
if(!vis){
  var before=a.style.transition; a.style.transition='none';
  var f=sig(a); a.blur(); var u=sig(a); a.focus();
  a.style.transition=before; if(!a.getAttribute('style')) a.removeAttribute('style');
  vis=f!==u;
}
var role=a.getAttribute('role');
return {label:(role?role+' ':'')+JSON.stringify(okpName(a)||a.tagName.toLowerCase()).slice(0,60), visible:vis};
})()`;

const COLLECT_KEYBOARD = `(function(){var K=window.__okpKb; return K.cand.filter(function(c){return K.reached.indexOf(c.el)<0}).map(function(c){return c.label+(c.reason?' ('+c.reason+')':'')})})()`;

/** Tabs through the page from the top. mode 'reach' fails on controls Tab never lands on; 'focus' on focused controls with no visible change. */
async function keyboard(page: Page, mode: 'reach' | 'focus'): Promise<CheckResult> {
  const count = await page.evaluate<number>(SETUP_KEYBOARD);
  const invisible: string[] = [];
  const max = Math.min(count + 10, 150);
  for (let i = 0; i < max; i++) {
    await page.press('Tab');
    const s = await page.evaluate<{ end?: boolean; repeat?: boolean; label?: string; visible?: boolean }>(SAMPLE_KEYBOARD);
    if (s.end || s.repeat) break;
    if (s.visible === false && s.label) invisible.push(s.label);
  }
  if (mode === 'reach') {
    const missed = await page.evaluate<string[]>(COLLECT_KEYBOARD);
    return missed.length === 0 ? ok : fail(`${missed.length} control${missed.length > 1 ? 's' : ''} cannot be reached with the Tab key: ${clip(missed.slice(0, 5).join(', '))}`);
  }
  return invisible.length === 0 ? ok : fail(`${invisible.length} focused control${invisible.length > 1 ? 's' : ''} show no visible focus indicator: ${clip(invisible.slice(0, 5).join(', '))}`);
}
