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
    // 管理員緩存較久；普通成員短期緩存（降級/升級最多延遲 MEMBER_CACHE_TTL 生效）
    const isAdmin = status === 'creator' || status === 'administrator';
    const ttl = isAdmin ? CONFIG.ADMIN_CACHE_TTL : CONFIG.MEMBER_CACHE_TTL;
    await env.TG_GUARD_KV.put(cacheKey, status, { expirationTtl: ttl });
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

// 無意義噪音訊息計數：遇有意義訊息即清零，僅機器人式「純噪音 drip」會累加
// isNoise 由 detector.isNoiseMessage 判定；返回視窗內累計噪音數
export async function checkNoiseSpam(env, chatId, userId, isNoise) {
  const key = `noise:${chatId}:${userId}`;
  if (!isNoise) {
    // 正常訊息 → 重置（fire-and-forget，不阻塞主流程）
    env.TG_GUARD_KV.delete(key);
    return 0;
  }
  const count = parseInt(await env.TG_GUARD_KV.get(key) || '0') + 1;
  await env.TG_GUARD_KV.put(key, count.toString(), { expirationTtl: CONFIG.NOISE_MSG_WINDOW });
  return count;
}

export async function recordUserJoinTime(env, chatId, userId) {
  const key = `join:${chatId}:${userId}`;
  const now = Math.floor(Date.now() / 1000);
  // 保留入群時間 24 小時（足夠覆蓋 5 分鐘的檢查，也可供後續扩展使用）
  await env.TG_GUARD_KV.put(key, now.toString(), { expirationTtl: 24 * 3600 });
}

export async function isUserInCooldown(env, chatId, userId) {
  const key = `join:${chatId}:${userId}`;
  const [joinTimeStr, highRiskFlag] = await Promise.all([
    env.TG_GUARD_KV.get(key),
    env.TG_GUARD_KV.get(`highrisk:${chatId}:${userId}`)
  ]);
  if (!joinTimeStr) return false;
  const joinTime = parseInt(joinTimeStr);
  const now = Math.floor(Date.now() / 1000);
  const window = highRiskFlag ? CONFIG.HIGHRISK_COOLDOWN : 5 * 60;
  return (now - joinTime) <= window;
}

// 高風險帳號標記（無頭像 → 延長冷卻期至 30 分鐘）
export async function markHighRisk(env, chatId, userId) {
  await env.TG_GUARD_KV.put(`highrisk:${chatId}:${userId}`, '1', { expirationTtl: CONFIG.HIGHRISK_COOLDOWN + 60 });
}

// 訊息計數：用於「前 N 條訊息保護期」，返回本條之後的累計數
export async function incrementMsgCount(env, chatId, userId) {
  const key = `msgcount:${chatId}:${userId}`;
  const count = parseInt(await env.TG_GUARD_KV.get(key) || '0') + 1;
  // 保留 30 天
  await env.TG_GUARD_KV.put(key, count.toString(), { expirationTtl: 30 * 24 * 3600 });
  return count;
}

// ─── 自訂黑名單（KV 儲存，管理員可動態增刪）──────────────────
// type ∈ 'link' | 'user' | 'forward' | 'kw'
// link/user/forward 值為 string；kw 值為 string[]（AND 組合）
const BL_TYPES = new Set(['link', 'user', 'forward', 'kw', 'image']);

export async function getCustomBlacklist(env, type) {
  if (!BL_TYPES.has(type)) return [];
  const data = await env.TG_GUARD_KV.get(`bl:${type}`);
  if (!data) return [];
  try {
    const arr = JSON.parse(data);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function addToBlacklist(env, type, value) {
  if (!BL_TYPES.has(type)) return null;
  const list = await getCustomBlacklist(env, type);
  // kw 用 JSON 字串比對唯一性，避免重複加入
  const serialize = (v) => typeof v === 'string' ? v : JSON.stringify(v);
  const exists = list.some(item => serialize(item) === serialize(value));
  if (!exists) {
    list.push(value);
    await env.TG_GUARD_KV.put(`bl:${type}`, JSON.stringify(list));
  }
  return list;
}

export async function removeFromBlacklist(env, type, value) {
  if (!BL_TYPES.has(type)) return null;
  const list = await getCustomBlacklist(env, type);
  const serialize = (v) => typeof v === 'string' ? v : JSON.stringify(v);
  const target = serialize(value);
  const next = list.filter(item => serialize(item) !== target);
  await env.TG_GUARD_KV.put(`bl:${type}`, JSON.stringify(next));
  return next;
}
