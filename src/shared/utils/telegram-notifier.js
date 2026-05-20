/**
 * Telegram notifier via the Bot API.
 *
 * Setup (one-time, 2 minutes — no SMS, no external service):
 *   1. Open Telegram, search "@BotFather"
 *   2. Send: /newbot
 *   3. Choose a name (e.g. "Recipe Automator")
 *   4. Choose a username (must end in "bot", e.g. "recipe_automator_bot")
 *   5. BotFather replies with a token like "1234567890:AAExxxx..."
 *   6. Search for YOUR new bot in Telegram → open chat → send /start
 *   7. In the dashboard, paste the token + click "Fetch chat ID" — the system
 *      reads getUpdates to find your chat ID automatically.
 *
 * Endpoint:
 *   POST https://api.telegram.org/bot<TOKEN>/sendMessage
 *   body: { chat_id, text, parse_mode }
 *
 * No rate limit for personal use. Push notifications on your phone if the
 * Telegram app is installed. Messages support Markdown formatting.
 */

import { Logger } from './logger.js';

const API_BASE = 'https://api.telegram.org';

/**
 * Send a Telegram message. Returns true on success, false on failure
 * (logs error but does NOT throw — notifications must never break the pipeline).
 */
export async function sendTelegram(config, message) {
  if (!config?.botToken || !config?.chatId) {
    Logger.debug('[Telegram] not configured — skipping notification');
    return false;
  }
  const token = String(config.botToken).trim();
  const chatId = String(config.chatId).trim();
  if (!token || !chatId) {
    Logger.warn('[Telegram] botToken or chatId empty after sanitization');
    return false;
  }
  // Telegram's per-message limit is 4096 chars
  const text = String(message || '').slice(0, 4000);
  const url = `${API_BASE}/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      Logger.warn(`[Telegram] HTTP ${res.status}: ${json?.description || 'no detail'}`);
      return false;
    }
    Logger.info('[Telegram] ✓ message sent');
    return true;
  } catch (e) {
    Logger.warn(`[Telegram] send failed: ${e.message}`);
    return false;
  }
}

/**
 * Test the Telegram config by sending a hello message.
 */
export async function testTelegram(config) {
  if (!config?.botToken || !config?.chatId) {
    return { ok: false, error: 'botToken and chatId are required' };
  }
  const token = String(config.botToken).trim();
  const chatId = String(config.chatId).trim();
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const text = `✓ <b>Recipe Automator test</b>\nTelegram notifications are working at ${new Date().toLocaleString()}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch the most recent chat ID from the bot's getUpdates endpoint.
 *
 * After the user creates a bot via @BotFather and sends /start (or any
 * message) to it, that chat appears in getUpdates. We extract the chat.id
 * from the latest message. The user no longer needs to look it up manually.
 *
 * Returns { ok, chatId, chatName, error }.
 */
export async function fetchChatId(botToken) {
  const token = String(botToken || '').trim();
  if (!token) return { ok: false, error: 'botToken required' };
  const url = `${API_BASE}/bot${token}/getUpdates`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description || `HTTP ${res.status}` };
    }
    const updates = json.result || [];
    if (updates.length === 0) {
      return {
        ok: false,
        error: 'No messages yet — open your bot in Telegram and send /start (or any message), then retry.',
      };
    }
    // Take the most recent message's chat
    const latest = updates[updates.length - 1];
    const chat = latest.message?.chat || latest.channel_post?.chat || latest.my_chat_member?.chat;
    if (!chat?.id) {
      return { ok: false, error: 'Could not find a chat in getUpdates — try sending /start to your bot.' };
    }
    const chatName = chat.first_name || chat.title || chat.username || '(unnamed)';
    return { ok: true, chatId: String(chat.id), chatName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
