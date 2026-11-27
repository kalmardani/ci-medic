#!/usr/bin/env node
// Build the sample-shop fixture as a real git repository with history.
// Commit 1 has a correct cart total, commit 2 is the regression that the
// example log shows. Usage: node examples/make-sample-repo.js <empty target dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FINAL = path.join(HERE, 'sample-repo');

export const CART_V1 = `// Cart totals in integer cents.

export function lineTotal(item) {
  return item.priceCents * item.qty;
}

export function cartTotal(items, { discountPercent = 0 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  const discount = Math.round((subtotal * discountPercent) / 100);
  return subtotal - discount;
}
`;

function git(cwd, args, date) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Sample Author', '-c', 'user.email=sample@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env, encoding: 'utf8', shell: false },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      copyTree(a, b);
    } else fs.copyFileSync(a, b);
  }
}

export function makeSampleRepo(dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length > 0) throw new Error(`${dest} is not empty`);
  git(dest, ['init', '-q']);
  copyTree(FINAL, dest);
  const cart = path.join(dest, 'src', 'cart.js');
  const regressed = fs.readFileSync(cart, 'utf8');
  fs.writeFileSync(cart, CART_V1);
  git(dest, ['add', '-A']);
  git(dest, ['commit', '-q', '-m', 'feat: cart totals with discount'], '2026-11-20T10:00:00Z');
  fs.writeFileSync(cart, regressed);
  git(dest, ['add', '-A']);
  git(dest, ['commit', '-q', '-m', 'refactor: apply the discount per line'], '2026-11-26T15:30:00Z');
  return dest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) {
    process.stderr.write('usage: node examples/make-sample-repo.js <empty target dir>\n');
    process.exitCode = 2;
  } else {
    makeSampleRepo(path.resolve(dest));
    process.stdout.write(`sample-shop repository created in ${path.resolve(dest)}\n`);
  }
}
