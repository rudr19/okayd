// Scripts that run inside the page for probes and checks. They are plain strings
// evaluated through the driver; nothing here is built from page or user input except
// through JSON.stringify, and none of it uses a RegExp built from input.

/** Helpers shared by every script: a control's accessible-ish name, and whether it is actually shown. */
export const DOM_HELPERS = String.raw`
function okpName(e){
  var a=e.getAttribute('aria-label'); if(a&&a.trim()) return a.replace(/\s+/g,' ').trim();
  var t=(e.tagName==='INPUT'&&(e.type==='submit'||e.type==='button'||e.type==='reset'))?(e.value||''):(e.innerText||'');
  if(!t.trim()){var img=e.querySelector&&e.querySelector('img[alt]'); if(img) t=img.getAttribute('alt')||'';}
  if(!t.trim()) t=e.getAttribute('title')||e.getAttribute('placeholder')||'';
  return t.replace(/\s+/g,' ').trim();
}
function okpShown(e){
  var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') return false;
  var r=e.getBoundingClientRect(); return r.width>0&&r.height>0;
}
function okpMoved(e){
  for(var n=e;n&&n.nodeType===1;n=n.parentElement){var s=getComputedStyle(n); if(s.position==='fixed'||s.transform!=='none') return true;}
  return false;
}
`;

export interface InspectResult {
  /** Buttons that look like they submit something, by name. Destructive ones are left out. */
  submits: string[];
  /** Visible same-origin links that go to another page, in document order. */
  links: { name: string; href: string; nth: number }[];
  /** Names of controls that are visible and on screen at the current viewport. */
  controls: string[];
  heading: string;
  path: string;
}

const DESTRUCTIVE = ['delete', 'remove', 'cancel', 'logout', 'log out', 'sign out', 'signout', 'unsubscribe', 'reset', 'clear', 'deactivate', 'close account'];
const SUBMITISH = ['save', 'submit', 'add', 'create', 'send', 'post', 'order', 'buy', 'place', 'register', 'sign up', 'subscribe', 'update', 'apply', 'book', 'pay', 'checkout', 'continue'];

export const INSPECT_SCRIPT = `(function(){${DOM_HELPERS}
var DESTRUCTIVE=${JSON.stringify(DESTRUCTIVE)}, SUBMITISH=${JSON.stringify(SUBMITISH)};
function has(list,n){n=n.toLowerCase();return list.some(function(k){return n.indexOf(k)>=0})}
var submits=[], seen={};
Array.prototype.forEach.call(document.querySelectorAll('button,input[type=submit],input[type=button],[role=button]'),function(b){
  if(!okpShown(b)||b.disabled) return;
  var n=okpName(b); if(!n||seen[n]||has(DESTRUCTIVE,n)) return;
  var type=(b.getAttribute('type')||'').toLowerCase(), inForm=!!b.closest('form');
  var formSubmit=inForm&&(b.tagName==='BUTTON'?(type===''||type==='submit'):type==='submit');
  if(formSubmit||has(SUBMITISH,n)){seen[n]=1;submits.push(n);}
});
var controls=[], cseen={};
Array.prototype.forEach.call(document.querySelectorAll('button,a[href],input,select,textarea,[role=button]'),function(e){
  if(e.tagName==='INPUT'&&e.type==='hidden') return;
  if(!okpShown(e)) return;
  var r=e.getBoundingClientRect(); if(!(r.left<window.innerWidth&&r.right>0)) return;
  var n=okpName(e); if(!n||cseen[n]) return; cseen[n]=1; controls.push(n);
});
var links=[], counts={}, here=location.pathname+location.search;
Array.prototype.forEach.call(document.querySelectorAll('a[href]'),function(a){
  if(!okpShown(a)) return;
  var n=okpName(a); var k=n; var nth=counts[k]||0; counts[k]=nth+1;
  if(!n||a.target==='_blank'||a.hasAttribute('download')) return;
  var u; try{u=new URL(a.href,location.href)}catch(e){return}
  if(u.origin!==location.origin) return;
  if(u.pathname+u.search===here) return;
  links.push({name:n,href:u.pathname+u.search,nth:nth});
});
var h=document.querySelector('h1');
return {submits:submits.slice(0,3),links:links,controls:controls.slice(0,60),heading:h?(h.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80):'',path:here};
})()`;
