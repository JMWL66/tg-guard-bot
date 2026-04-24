import { CONFIG, SYSTEM_BOT_IDS } from './config.js';
import { callTelegramAPI, simpleHash } from './utils.js';

export async function getMemberStatus(botToken, env, chatId, userId, senderChat) {
  // 匿名管理員：sender_chat 是本群自身
  if (senderChat && senderChat.id === chatId) return 'administrator';

  // Telegram 系統帳號（GroupAnonymousBot 等）必須在 senderChat fallback 之前檢查
  if (userId && SYSTEM_BOT_IDS.has(userId)) return 'administrator';

  // 外部頻道以頻道身份發言，且非系統帳號 → 視為普通成員
  if (senderChat) return 'member';

  if (!userId) return 'member';

  const cacheKey = `admin_cache:${chatId}:${userId}`;
  const cached = await env.TG_GUARD_KV.get(cacheKey);
  if (cached) return cached;

  const result = await callTelegramAPI(botToken, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (result.ok) {
    const status = result.result.status;
    if (status === 'creator' || status === 'administrator') {
      await env.TG_GUARD_KV.put(cacheKey, status, { expirationTtl: CONFIG.ADMIN_CACHE_TTL });
    }
    return status;
  }
  return 'member';
}

export async function getDynamicWhitelist(env, chatId) {
  const data = await env.TG_GUARD_KV.get(`whitelist:${chatId}`);
  return data ? JSON.parse(data) : [];
}

export async function getDynamicUserWhitelist(env, chatId) {
  const data = await env.TG_GUARD_KV.get(`whitelist_users:${chatId}`);
  return data ? (Array.isArray(JSON.parse(data)) ? JSON.parse(data) : []) : [];
}

export async function checkRateLimit(env, chatId, userId) {
  const key = `rate:${chatId}:${userId}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await env.TG_GUARD_KV.get(key);
  let state = raw ? JSON.parse(raw) : { count: 0, start: now };

  if (now - state.start > CONFIG.RATE_LIMIT_WINDOW) {
    state = { count: 1, start: now };
  } else {
    state.count++;
  }
  await env.TG_GUARD_KV.put(key, JSON.stringify(state), { expirationTtl: CONFIG.RATE_LIMIT_WINDOW });
  return state.count > CONFIG.RATE_LIMIT_MAX;
}

export async function checkDuplicate(env, chatId, userId, text) {
  if (!text || text.trim().length < 10) return false;
  const hash = simpleHash(text.trim().toLowerCase());
  const key = `dup:${chatId}:${userId}:${hash}`;
  const exists = await env.TG_GUARD_KV.get(key);
  if (exists) return true;
  await env.TG_GUARD_KV.put(key, '1', { expirationTtl: CONFIG.DUP_WINDOW });
  return false;
}

export async function incrementViolations(env, chatId, userId) {
  const key = `violations:${chatId}:${userId}`;
  const count = parseInt(await env.TG_GUARD_KV.get(key) || '0') + 1;
  await env.TG_GUARD_KV.put(key, count.toString(), { expirationTtl: CONFIG.VIOLATION_TTL });
  return count;
}

export async function checkShortMessageSpam(env, chatId, userId, text) {
  const trimmed = (text || '').trim();
  const key = `shortmsg:${chatId}:${userId}`;

  if (trimmed.length >= CONFIG.SHORT_MSG_MIN_LEN) {
    // 正常訊息 → 重置計數（fire-and-forget，不影響主流程）
    env.TG_GUARD_KV.delete(key);
    return false;
  }

  const count = parseInt(await env.TG_GUARD_KV.get(key) || '0') + 1;
  await env.TG_GUARD_KV.put(key, count.toString(), { expirationTtl: CONFIG.SHORT_MSG_WINDOW });
  return count >= CONFIG.SHORT_MSG_MAX;
}
