import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, lineTotal } from '../src/cart.js';

test('line total multiplies price by quantity', () => {
  assert.equal(lineTotal({ priceCents: 250, qty: 4 }), 1000);
});

test('cart total without discount', () => {
  assert.equal(cartTotal([{ priceCents: 199, qty: 2 }, { priceCents: 101, qty: 1 }]), 499);
});

test('cart total rounds the discount once on the subtotal', () => {
  const items = [
    { priceCents: 333, qty: 1 },
    { priceCents: 333, qty: 1 },
    { priceCents: 333, qty: 1 },
  ];
  assert.equal(cartTotal(items, { discountPercent: 10 }), 899);
});
