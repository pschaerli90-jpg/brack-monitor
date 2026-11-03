export function priority(product) {
  if (product.brand !== 'pokemon') return 0;
  if (product.language === 'en' && product.category === 'tcg') return 2;
  if (product.language === 'de' && product.category === 'tcg' && product.series === '30-jahre-jubilaeum') return 1;
  return 0;
}

export function validateProduct(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim() ||
      typeof p.name !== 'string' || !p.name.trim() ||
      !['brand', 'category', 'language', 'series'].every(k => typeof p[k] === 'string')) {
    throw new Error('Ungültige Produktidentität oder Klassifikation');
  }
}

export function quantityPlan(p) {
  for (const key of ['stock', 'maxPerOrder', 'existingQuantity']) {
    if (!Number.isSafeInteger(p[key]) || p[key] < 0) throw new Error(`Ungültige oder unbekannte Menge: ${key}`);
  }
  const targetQuantity = Math.min(p.stock, p.maxPerOrder);
  if (p.existingQuantity > targetQuantity) throw new Error('Bestehende Menge überschreitet aktuelles Limit');
  return { targetQuantity, existingQuantity: p.existingQuantity, addQuantity: targetQuantity - p.existingQuantity };
}
