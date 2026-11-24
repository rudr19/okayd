// Turns Accessibility.getFullAXTree nodes into a short, stable text snapshot.

export interface AXValue { type?: string; value?: unknown }
export interface AXProperty { name: string; value: AXValue }
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface Snapshot {
  text: string;
  refs: Map<string, number>;
}

const STRUCTURAL = new Set(['generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'RootWebArea', 'WebArea']);
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'tab', 'treeitem',
]);
const STATES = ['level', 'checked', 'expanded', 'selected', 'disabled', 'required', 'pressed'];
const MAX_NAME = 100;

function str(v: AXValue | undefined): string {
  const x = v?.value;
  return x === undefined || x === null ? '' : String(x);
}

function quote(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  const cut = clean.length > MAX_NAME ? clean.slice(0, MAX_NAME) + '…' : clean;
  return JSON.stringify(cut);
}

export function buildSnapshot(axNodes: AXNode[]): Snapshot {
  const byId = new Map<string, AXNode>();
  for (const n of axNodes) byId.set(n.nodeId, n);
  const lines: { depth: number; text: string; name: string }[] = [];
  const refs = new Map<string, number>();
  let counter = 0;

  const children = (n: AXNode): AXNode[] =>
    (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c);

  const walk = (n: AXNode, depth: number): void => {
    const role = str(n.role);
    if (n.ignored || STRUCTURAL.has(role) || role === '') {
      for (const c of children(n)) walk(c, depth);
      return;
    }
    const name = str(n.name).replace(/\s+/g, ' ').trim();
    const isStatic = role === 'StaticText';
    if (isStatic) {
      const prev = lines[lines.length - 1];
      if (!name || (prev && prev.name === name)) return;
      lines.push({ depth, text: `StaticText ${quote(name)}`, name });
      return;
    }
    let text = role;
    if (name) text += ` ${quote(name)}`;
    if (INTERACTIVE.has(role) && n.backendDOMNodeId !== undefined) {
      const ref = `e${++counter}`;
      refs.set(ref, n.backendDOMNodeId);
      text += ` [ref=${ref}]`;
    }
    for (const p of n.properties ?? []) {
      if (!STATES.includes(p.name)) continue;
      const v = p.value?.value;
      if (v === false || v === undefined || v === null || v === 'false') continue;
      text += v === true || v === 'true' ? ` [${p.name}]` : ` [${p.name}=${String(v)}]`;
    }
    const value = str(n.value);
    if (value) text += ` value=${quote(value)}`;
    lines.push({ depth, text, name });
    for (const c of children(n)) walk(c, depth + 1);
  };

  const roots = axNodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  for (const r of roots) walk(r, 0);

  const text = lines.map((l) => '  '.repeat(l.depth) + '- ' + l.text).join('\n');
  return { text, refs };
}
