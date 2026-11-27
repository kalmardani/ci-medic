// Shared test helpers. No network anywhere in the test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSampleRepo } from '../examples/make-sample-repo.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLES = path.join(ROOT, 'examples', 'logs');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');

export function tmpDir(prefix = 'ci-medic-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fresh sample-shop git repository. Returns {dir, cleanup}. */
export function sampleRepo() {
  const base = tmpDir();
  const dir = path.join(base, 'shop');
  makeSampleRepo(dir);
  return { dir, base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function readExample(name) {
  return fs.readFileSync(path.join(EXAMPLES, name), 'utf8');
}

export function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export const FIX_PATCH = `diff --git a/src/cart.js b/src/cart.js
--- a/src/cart.js
+++ b/src/cart.js
@@ -4,10 +4,8 @@ export function lineTotal(item) {
   return item.priceCents * item.qty;
 }

-function discounted(cents, percent) {
-  return Math.floor((cents * (100 - percent)) / 100);
-}
-
 export function cartTotal(items, { discountPercent = 0 } = {}) {
-  return items.reduce((sum, item) => sum + discounted(lineTotal(item), discountPercent), 0);
+  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
+  const discount = Math.round((subtotal * discountPercent) / 100);
+  return subtotal - discount;
 }
`;

/** A valid model answer for the node-regression example. */
export function goodAnswer(overrides = {}) {
  return {
    category: 'regression',
    confidence: 0.9,
    summary: 'The per line discount refactor floors each line, so the cart total is 2 cents too low.',
    root_cause:
      'Commit "refactor: apply the discount per line" changed cartTotal to floor the discounted price of every line. Three lines of 333 cents at 10 percent give 299 each, 897 in total, while rounding the discount once on the subtotal gives 899.',
    evidence: [
      { quote: '897 !== 899', explains: 'The total is two cents below the expected value.' },
      { quote: '✖ cart total rounds the discount once on the subtotal (24.934296ms)', explains: 'The failing test checks rounding on the subtotal.' },
    ],
    suggested_fix: 'Compute the subtotal first and round the discount once.',
    patch: FIX_PATCH,
    ...overrides,
  };
}

export const nodeRuns = process.execPath;
