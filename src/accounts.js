export const MOCK_ACCOUNTS = Object.freeze(Array.from({ length: 4 }, (_, i) => Object.freeze({ id: `mock-account-${i + 1}`, mode: 'mock' })));

export function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length !== 4 || new Set(accounts.map(a => a?.id)).size !== 4 ||
      accounts.some(a => a?.mode !== 'mock' || !/^mock-account-[1-4]$/.test(a.id))) {
    throw new Error('Genau vier eindeutige simulierte Konten mock-account-1 bis -4 erforderlich');
  }
}

export class MockAccountAdapter {
  constructor({ loginFailures = [], cartFailures = [] } = {}) {
    this.loginFailures = new Set(loginFailures);
    this.cartFailures = new Set(cartFailures);
  }
  async login(account) {
    if (this.loginFailures.has(account.id)) throw new Error('Simulierter Loginfehler');
    return { mode: 'mock', accountId: account.id, token: `simulation:${account.id}` };
  }
  async prepare({ account, session, product, targetQuantity, idempotencyKey }) {
    if (session?.mode !== 'mock' || session.accountId !== account.id) throw new Error('Fremde oder ungültige Sitzung');
    if (this.cartFailures.has(account.id)) throw new Error('Simulierter Warenkorbfehler');
    return { mode: 'mock', accountId: account.id, productId: product.id, targetQuantity, reference: idempotencyKey };
  }
}
