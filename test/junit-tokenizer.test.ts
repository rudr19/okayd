import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJUnit, decodeEntities, MAX_RESULTS_BYTES } from '../src/junit.js';
import { parseCTRF } from '../src/ctrf.js';
import { readResultsFile } from '../src/results-file.js';

const wrap = (body: string): string => `<?xml version="1.0"?><testsuites><testsuite name="s">${body}</testsuite></testsuites>`;

test('junit: ">" and "/" inside quoted attribute values do not end the tag', () => {
  const out = parseJUnit(wrap(`<testcase name="a > b / c [okproof:1.1]" classname="x/y>z"><failure message="1 > 0"/></testcase>`));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'a > b / c [okproof:1.1]');
  assert.equal(out[0].status, 'failed');
});

test('junit: single-quoted attributes and a testcase after a ">" attribute', () => {
  const out = parseJUnit(wrap(`<testcase name='one > two' time='1.5'/><testcase name="three"/>`));
  assert.deepEqual(out.map((o) => o.title), ['one > two', 'three']);
  assert.match(out[0].evidence ?? '', /1\.5s/);
});

test('junit: a testcase inside an XML comment does not count', () => {
  const out = parseJUnit(wrap(`<!-- <testcase name="ghost [okproof:1.1]"/> --><testcase name="real"/>`));
  assert.deepEqual(out.map((o) => o.title), ['real']);
});

test('junit: failure markup inside a comment or CDATA does not fail the test', () => {
  const out = parseJUnit(wrap(`<testcase name="a"><system-out><![CDATA[<failure message="x"/> <testcase name="fake"/>]]></system-out><!-- <failure/> --></testcase>`));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'passed');
});

test('junit: processing instructions and DOCTYPE are skipped', () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY x "<testcase name='bad'/>">]><?pi <testcase name="pi"/> ?>${wrap('<testcase name="ok"/>')}`;
  assert.deepEqual(parseJUnit(xml).map((o) => o.title), ['ok']);
});

test('junit: entities decode in one pass', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp;lt; &quot;q&quot; &apos;s&apos; &#65;&#x42; &#0; &#xD800; &bogus; &#1114112;'), '<a> &lt; "q" \'s\' AB &#0; &#xD800; &bogus; &#1114112;');
  const out = parseJUnit(wrap(`<testcase name="x &amp; y &#x263A; &lt;z&gt;"/>`));
  assert.equal(out[0].title, 'x & y ☺ <z>');
});

test('junit: namespaced tags and nested suites', () => {
  const xml = `<ns:testsuites xmlns:ns="u"><ns:testsuite name="a"><ns:testsuite name="b"><ns:testcase name="deep"><ns:skipped/></ns:testcase></ns:testsuite><ns:testcase name="shallow"><ns:error/></ns:testcase></ns:testsuite></ns:testsuites>`;
  const out = parseJUnit(xml);
  assert.deepEqual(out.map((o) => [o.title, o.status]), [['deep', 'skipped'], ['shallow', 'failed']]);
});

test('junit: flaky markers, rerun properties and assertions still work', () => {
  const out = parseJUnit(
    wrap(
      `<testcase name="f1"><flakyFailure message="m"/></testcase>` +
        `<testcase name="f2"><rerunError/></testcase>` +
        `<testcase name="f3"><properties><property name="rerun" value="2"/></properties></testcase>` +
        `<testcase name="p1"><properties><property name="rerun" value="0"/></properties></testcase>` +
        `<testcase name="a" assertions="3"/>`,
    ),
  );
  assert.deepEqual(out.map((o) => o.status), ['flaky', 'flaky', 'flaky', 'passed', 'passed']);
  assert.equal(out[4].assertions, 3);
});

test('junit: a rerun property outside any testcase does not make tests flaky', () => {
  const out = parseJUnit(`<testsuite><properties><property name="rerun" value="3"/></properties><testcase name="a"/></testsuite>`);
  assert.equal(out[0].status, 'passed');
});

test('junit: precedence skipped, then failed, then flaky', () => {
  const out = parseJUnit(wrap(`<testcase name="a"><flakyFailure/><failure/></testcase><testcase name="b"><failure/><skipped/></testcase>`));
  assert.deepEqual(out.map((o) => o.status), ['failed', 'skipped']);
});

test('junit: 8000 unclosed testcase tags parse in linear time', () => {
  const xml = '<testsuite>' + '<testcase name="x"><failure>'.repeat(8000);
  const t = Date.now();
  const out = parseJUnit(xml);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
  assert.equal(out.length, 8000);
});

test('junit: pathological quote and comment runs stay fast', () => {
  const t = Date.now();
  parseJUnit('<testcase name="' + 'a'.repeat(1_000_000));
  parseJUnit('<testcase '.repeat(50_000));
  parseJUnit('<!--'.repeat(100_000));
  parseJUnit('<a b="'.repeat(50_000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('junit: an oversize document is refused with a clear error', () => {
  assert.throws(() => parseJUnit(' '.repeat(MAX_RESULTS_BYTES + 1)), /larger than 50 MB/);
});

test('ctrf: an oversize document is refused with a clear error', () => {
  assert.throws(() => parseCTRF(' '.repeat(MAX_RESULTS_BYTES + 1)), /larger than 50 MB/);
});

test('readResultsFile: refuses an oversize file before reading it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okp-res-'));
  try {
    const p = join(dir, 'r.xml');
    await writeFile(p, '<testsuite/>');
    assert.equal(await readResultsFile(p), '<testsuite/>');
    await assert.rejects(() => readResultsFile(p, 5), /larger than/);
    await assert.rejects(() => readResultsFile(join(dir, 'missing.xml')), /ENOENT|no such file/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
