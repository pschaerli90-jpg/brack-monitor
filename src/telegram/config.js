import { open, constants } from 'node:fs/promises';

export function validateTelegramConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.botToken !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(value.botToken) ||
      typeof value.chatId !== 'string' || !/^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value.chatId)) {
    throw new Error('Ungültige lokale Telegram-Konfiguration; Bot-Token und Chat-ID prüfen');
  }
  return Object.freeze({ botToken: value.botToken, chatId: value.chatId });
}

export async function loadTelegramConfig({ path, env = process.env } = {}) {
  const filename = path ?? env.BRACK_TELEGRAM_CONFIG;
  if (filename && (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID)) {
    throw new Error('Nur eine lokale Telegram-Konfigurationsquelle verwenden');
  }
  if (!filename) return validateTelegramConfig({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
  let handle;
  try {
    // O_NOFOLLOW prevents loading an unexpectedly substituted symbolic link.
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('permissions');
    return validateTelegramConfig(JSON.parse(await handle.readFile('utf8')));
  } catch {
    // JSON errors, paths, URLs and configuration contents must never reach logs.
    throw new Error('Lokale Telegram-Konfiguration nicht lesbar oder ungültig; reguläre eigene Datei mit Modus 0600 verwenden');
  } finally { await handle?.close(); }
}
