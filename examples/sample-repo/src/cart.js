// Cart totals in integer cents.

export function lineTotal(item) {
  return item.priceCents * item.qty;
}

function discounted(cents, percent) {
  return Math.floor((cents * (100 - percent)) / 100);
}

export function cartTotal(items, { discountPercent = 0 } = {}) {
  return items.reduce((sum, item) => sum + discounted(lineTotal(item), discountPercent), 0);
}
