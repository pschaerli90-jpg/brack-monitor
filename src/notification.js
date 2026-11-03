export function preparationMessage({ account, product, plan }) {
  return 'TEST – Warenkorbvorbereitung simuliert\nProdukt: ' + product.name +
    '\nMenge: ' + plan.targetQuantity + '\nKonto: ' + account.id +
    '\nLink: ' + (product.url ?? 'nicht vorhanden (Offline-Fixture)') +
    '\nKeine echte Warenkorbänderung, keine Bestellung.';
}

// Builds a Telegram sendMessage-compatible preview without a network transport or token.
export class TelegramPreview {
  async send(message, { idempotencyKey }) {
    if (typeof message !== 'string' || message.length > 4096) throw new Error('Ungültige Telegram-Nachrichtenlänge');
    return { mode: 'mock', delivery: 'preview-only', reference: idempotencyKey, message,
      payload: { text: message, link_preview_options: { is_disabled: true } } };
  }
}
