import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, type AXNode } from '../src/driver/snapshot.js';

const n = (
  id: string,
  role: string,
  extra: Partial<AXNode> & { nameText?: string; valueText?: string; props?: Record<string, unknown> } = {},
): AXNode => ({
  nodeId: id,
  role: { type: 'role', value: role },
  name: extra.nameText !== undefined ? { type: 'string', value: extra.nameText } : undefined,
  value: extra.valueText !== undefined ? { type: 'string', value: extra.valueText } : undefined,
  properties: Object.entries(extra.props ?? {}).map(([name, value]) => ({ name, value: { value } })),
  childIds: extra.childIds,
  parentId: extra.parentId,
  ignored: extra.ignored,
  backendDOMNodeId: extra.backendDOMNodeId,
});

test('snapshot: refs only on interactive roles, in document order', () => {
  const nodes = [
    n('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }),
    n('2', 'heading', { nameText: 'Rudra', props: { level: 1 }, backendDOMNodeId: 10, parentId: '1' }),
    n('3', 'link', { nameText: 'Skip', backendDOMNodeId: 11, parentId: '1' }),
    n('4', 'textbox', { nameText: 'Email', valueText: 'a@b.co', backendDOMNodeId: 12, parentId: '1' }),
    n('5', 'button', { nameText: 'Send', props: { disabled: true }, backendDOMNodeId: 13, parentId: '1' }),
  ];
  const { text, refs } = buildSnapshot(nodes);
  assert.equal(
    text,
    [
      '- heading "Rudra" [level=1]',
      '- link "Skip" [ref=e1]',
      '- textbox "Email" [ref=e2] value="a@b.co"',
      '- button "Send" [ref=e3] [disabled]',
    ].join('\n'),
  );
  assert.deepEqual([...refs], [['e1', 11], ['e2', 12], ['e3', 13]]);
});

test('snapshot: structural and ignored nodes are lifted, depth is 2 spaces', () => {
  const nodes = [
    n('1', 'RootWebArea', { childIds: ['2'] }),
    n('2', 'generic', { childIds: ['3', '6'], parentId: '1' }),
    n('3', 'navigation', { nameText: 'Main', childIds: ['4'], parentId: '2' }),
    n('4', 'none', { childIds: ['5'], parentId: '3' }),
    n('5', 'link', { nameText: 'Home', backendDOMNodeId: 5, parentId: '4' }),
    n('6', 'paragraph', { ignored: true, childIds: ['7'], parentId: '2' }),
    n('7', 'button', { nameText: 'Go', backendDOMNodeId: 7, parentId: '6' }),
  ];
  const { text } = buildSnapshot(nodes);
  assert.equal(text, ['- navigation "Main"', '  - link "Home" [ref=e1]', '- button "Go" [ref=e2]'].join('\n'));
});

test('snapshot: interactive node without backendDOMNodeId gets no ref', () => {
  const { text, refs } = buildSnapshot([n('1', 'button', { nameText: 'Ghost' })]);
  assert.equal(text, '- button "Ghost"');
  assert.equal(refs.size, 0);
});

test('snapshot: states render as [name] or [name=value], false is dropped', () => {
  const nodes = [
    n('1', 'checkbox', { nameText: 'A', props: { checked: 'true', required: true, expanded: false }, backendDOMNodeId: 1 }),
    n('2', 'checkbox', { nameText: 'B', props: { checked: 'mixed', selected: true }, backendDOMNodeId: 2 }),
  ];
  const { text } = buildSnapshot(nodes);
  assert.equal(
    text,
    ['- checkbox "A" [ref=e1] [checked] [required]', '- checkbox "B" [ref=e2] [checked=mixed] [selected]'].join('\n'),
  );
});

test('snapshot: long names are truncated to 100 chars with an ellipsis', () => {
  const { text } = buildSnapshot([n('1', 'heading', { nameText: 'x'.repeat(250) })]);
  assert.equal(text, `- heading "${'x'.repeat(100)}…"`);
});

test('snapshot: StaticText repeating the line above is dropped, other text kept', () => {
  const nodes = [
    n('1', 'RootWebArea', { childIds: ['2', '4'] }),
    n('2', 'link', { nameText: 'Docs', childIds: ['3'], backendDOMNodeId: 2, parentId: '1' }),
    n('3', 'StaticText', { nameText: 'Docs', parentId: '2' }),
    n('4', 'StaticText', { nameText: 'Other', parentId: '1' }),
  ];
  const { text } = buildSnapshot(nodes);
  assert.equal(text, ['- link "Docs" [ref=e1]', '- StaticText "Other"'].join('\n'));
});
