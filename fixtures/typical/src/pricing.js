export const TAX_RATE = 0.07;

export function priceWithTax(amount) {
  return Math.round(amount * (1 + TAX_RATE) * 100) / 100;
}

export function tierFor(quantity) {
  if (quantity >= 100) return "enterprise";
  if (quantity >= 10) return "team";
  return "starter";
}
