import { log } from './utils.js';

const CAS_API = 'https://api.cas.chat/check';
const POS_TTL = 24 * 3600;   // 命中：24h 緩存
const NEG_TTL = 6 * 3600;    // 未命中：6h 緩存，降低 API 壓力

export async function checkCAS(env, userId) {
  if (!userId) return { banned: false };
  const cacheKey = `cas:${userId}`;
  const cached = await env.TG_GUARD_KV.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fallthrough */ }
  }

  try {
    const resp = await fetch(`${CAS_API}?user_id=${userId}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return { banned: false };
    const data = await resp.json();
    const result = (data.ok && data.result)
      ? { banned: true, offenses: data.result.offenses || 0, time: data.result.time_added || null }
      : { banned: false };
    await env.TG_GUARD_KV.put(cacheKey, JSON.stringify(result), {
      expirationTtl: result.banned ? POS_TTL : NEG_TTL
    });
    return result;
  } catch (e) {
    log('warn', 'CAS check failed', { userId, error: e.message });
    return { banned: false };
  }
}
