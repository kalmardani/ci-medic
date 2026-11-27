import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLog, reduceLog, extractLocations, isErrorLine, isInternalFrame, mergeWindows, MAX_LINE } from '../src/log/reduce.js';
import { failureSignature, normalizeForSignature } from '../src/log/signature.js';
import { readExample, readFixture } from './_helpers.js';

test('normalizeLog handles CRLF, progress carriage returns, ANSI, timestamps and bidi', () => {
  const raw = '2026-11-27T10:00:00.1234567Z \x1b[31mError: boom\x1b[0m\r\nDownloading 10%\rDownloading 100%\r\n[12:00:01] \u202eplain\x07\r\n\r\n';
  assert.deepEqual(normalizeLog(raw), ['Error: boom', 'Downloading 100%', 'plain']);
});

test('normalizeLog caps very long lines', () => {
  const lines = normalizeLog('x'.repeat(MAX_LINE * 3));
  assert.equal(lines[0].length, MAX_LINE);
});

test('consequence lines are never the first real error', () => {
  assert.equal(isErrorLine('##[error]Process completed with exit code 1.'), false);
  assert.equal(isErrorLine('npm error code 1'), false);
  assert.equal(isErrorLine('✖ failing tests:'), false);
  assert.equal(isErrorLine('Found 0 errors.'), false);
  assert.equal(isErrorLine('AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'), true);
  assert.equal(isErrorLine('src/a.ts(3,5): error TS2322: Type string is not assignable'), true);
});

test('node test runner example: first error, headline, failing test, locations', () => {
  const lines = normalizeLog(readExample('node-regression.log'));
  const r = reduceLog(lines);
  assert.equal(r.step, 'Run npm test');
  assert.match(r.firstError.text, /^✖ cart total rounds the discount once/);
  assert.match(r.headline.text, /^AssertionError \[ERR_ASSERTION\]/);
  assert.deepEqual(
    r.failingTests.map((t) => t.name),
    ['cart total rounds the discount once on the subtotal'],
  );
  const paths = r.locations.map((l) => `${l.path}:${l.line}`);
  assert.ok(paths.includes('/home/runner/work/sample-shop/sample-shop/spec/cart.spec.js:19'));
  assert.ok(!paths.some((p) => p.includes('node:') || p.includes('internal')));
  assert.match(r.view, /\[6 internal frames hidden\]/);
  assert.match(r.view, /L56 {2}\s*897 !== 899/);
  assert.ok(r.view.length < 4000);
});

test('pytest, go, cargo and tsc lines are recognised', () => {
  const lines = [
    'collected 3 items',
    'FAILED tests/test_cart.py::test_total - AssertionError: assert 897 == 899',
    '--- FAIL: TestTotal (0.00s)',
    'test cart::total ... FAILED',
    'src/cart.ts(12,7): error TS2304: Cannot find name foo.',
    '  File "/home/runner/work/x/x/app/cart.py", line 14, in total',
  ];
  const r = reduceLog(lines);
  assert.deepEqual(
    r.failingTests.map((t) => t.name),
    ['tests/test_cart.py::test_total', 'TestTotal', 'cart::total'],
  );
  const locs = r.locations.map((l) => `${l.path}:${l.line}`);
  assert.ok(locs.includes('src/cart.ts:12'));
  assert.ok(locs.includes('/home/runner/work/x/x/app/cart.py:14'));
});

test('extractLocations skips URLs, node internals and dependencies', () => {
  assert.deepEqual(extractLocations('see https://example.com:443/a.js:10 for details'), []);
  assert.deepEqual(extractLocations('at run (node:internal/test_runner/test.js:12:3)'), []);
  assert.deepEqual(extractLocations('at x (/app/node_modules/pg/index.js:45:11)'), []);
  assert.deepEqual(extractLocations('at y (file:///D:/a/repo/repo/src/x.js:3:9)'), [{ path: 'D:/a/repo/repo/src/x.js', line: 3, col: 9 }]);
  assert.deepEqual(extractLocations('C:\\work\\repo\\src\\x.ts(4,2): error TS1'), [{ path: 'C:\\work\\repo\\src\\x.ts', line: 4, col: 2 }]);
});

test('internal frames are recognised by their location only', () => {
  assert.equal(isInternalFrame('    at TestContext.<anonymous> (file:///home/r/spec/a.spec.js:19:10)'), false);
  assert.equal(isInternalFrame('    at Test.run (node:internal/test_runner/test:1402:25)'), true);
  assert.equal(isInternalFrame('    at async Promise.all (index 0)'), false);
});

test('no recognised error falls back to the tail of the log', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `step output ${i}`);
  const r = reduceLog(lines);
  assert.equal(r.firstError, null);
  assert.match(r.view, /no error line recognised/);
  assert.match(r.view, /L200 {2}step output 199/);
  assert.doesNotMatch(r.view, /L100 /);
});

test('the view stays inside the budget on a huge log with many errors', () => {
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(i % 50 === 0 ? `Error: failure number ${i} ${'x'.repeat(300)}` : `noise line ${i}`);
  const r = reduceLog(lines);
  assert.ok(r.view.length <= 12_000 + 2_100, `view length ${r.view.length}`);
  assert.equal(r.firstError.line, 1);
});

test('repeated lines collapse', () => {
  const lines = ['Error: start', ...Array(30).fill('retrying connection'), 'done'];
  const r = reduceLog(lines);
  assert.match(r.view, /\[previous line repeated 29 more times\]/);
});

test('mergeWindows merges overlapping and touching windows', () => {
  assert.deepEqual(mergeWindows([{ a: 10, b: 20 }, { a: 1, b: 5 }, { a: 6, b: 8 }, { a: 15, b: 30 }]), [
    { a: 1, b: 8 },
    { a: 10, b: 30 },
  ]);
});

test('signature ignores numbers, hashes and directory prefixes', () => {
  const a = reduceLog(['✖ total (1.2ms)', '  Error: expected 897 got 899 at /home/a/x.js', '']);
  const b = reduceLog(['✖ total (9.9ms)', '  Error: expected 13 got 12 at C:\\b\\x.js', '']);
  assert.equal(failureSignature(a), failureSignature(b));
  const c = reduceLog(['✖ total (1.2ms)', '  TypeError: cannot read x', '']);
  assert.notEqual(failureSignature(a), failureSignature(c));
  assert.match(failureSignature(a), /^[0-9a-f]{16}$/);
  assert.equal(normalizeForSignature('run 6884835c1f0d at /tmp/abc/def/file.js:12'), 'run <hex> at file.js:<n>');
});

test('signature of a log without errors comes from its tail', () => {
  const lines = ['a', 'b', 'c'];
  assert.match(failureSignature(reduceLog(lines), lines), /^[0-9a-f]{16}$/);
});

test('the injection line stays plain data in the view', () => {
  const r = reduceLog(normalizeLog(readFixture('injection.log')));
  assert.match(r.view, /ignore previous instructions/);
  assert.match(r.firstError.text, /^✖ cart total rounds/);
});
