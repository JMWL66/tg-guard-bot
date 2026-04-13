/**
 * tg-guard-bot — Cloudflare Workers Telegram 群組守衛機器人 (終極究極版)
 *
 * 功能核心：
 *  1. 🛡️ 新成員引導：入群歡迎與保護期提示
 *  2. ⚡ 極致效能：條件式讀取 KV，管理員狀態精準快取 (1h)
 *  3. ♻️ 權限同步：支援 /resetadmincache
 *  4. 🧹 隱形執行：指令執行後自動刪除，保持群組版面純淨
 *  5. 🔍 深度掃描：Regex + Telegram Entities 雙重過濾
 *  6. 🚫 零容忍：Forward / 連結 / 洗版 → 立即踢出，無警告
 */

// ─── 核心設定 ──────────────────────────────────────────────────
const CONFIG = {
  LANG: 'zh',
  ADMIN_CACHE_TTL: 3600,
  WELCOME_COOLDOWN_SEC: 10,
  RATE_LIMIT_WINDOW: 30,  // 秒：滑動視窗
  RATE_LIMIT_MAX: 5,      // 視窗內最大訊息數
  DUP_WINDOW: 60,         // 秒：重複訊息記憶時間
  SHORT_MSG_MIN_LEN: 2,   // 少於此字元數視為無意義短訊息
  SHORT_MSG_MAX: 3,       // 連續短訊息達此次數踢出
  SHORT_MSG_WINDOW: 60,   // 秒：連續短訊息計數視窗
  VIOLATION_TTL: 7 * 24 * 3600, // 違規計數保留時間 (7天)
  REGEX_URL: /(https?:\/\/[^\s]+|t\.me\/[^\s]+|telegram\.me\/[^\s]+|@\w{5,})/gi
};

const ALLOWED_TELEGRAM_KEYWORDS = ['paperworkbybryan'];
const ALLOWED_DOMAINS = ['youtube.com', 'github.com', 'clawhub.ai', 'platform.minimaxi.com', 'web3.okx.com', 'cryptofuture2026-neural-ledger.pages.dev', 'x.com'];

// Telegram 系統帳號 / 匿名管理員 ID，一律視為管理員
const SYSTEM_BOT_IDS = new Set([777000, 1087968824, 136817688]);

// 特許用戶 ID (不論任何情況直接豁免)
const WHITELISTED_USER_IDS = new Set([5977782504, 8310351580, 8447975470]);

// ─── 垃圾廣告黑名單 (由用戶提供) ────────────────────────────────
const BLACKLISTED_USERNAMES = new Set(['hy159159', 'hysq886888']);
const BLACKLISTED_INVITE_LINKS = new Set([
  'https://t.me/+VQxchulbjR84OWRl',
  'https://t.me/+ZyGE_h0-Bwk2MTVl',
  'https://t.me/+GC-peDjqpl42ZDFk',
  'https://t.me/+Ge5lo8V8uDo4ODdl',
  'https://t.me/+DydE0_0pr1c4NjY1',
  'https://t.me/+_20NHyKkibczZTU5',
  'https://t.me/+BCKNBdfXxAViM2Fh'
]);

// 關鍵詞組合黑名單：組內所有詞同時出現 → 刪除封禁
// 每個子陣列是一組「AND 條件」，任一組命中即觸發
const KEYWORD_SETS = [
  // ── 長句/特定話術 (從 PDF 提取) ──
  ['币圈免费', '合约策略'],
  ['每天', '精准策略'],
  ['合约交流裙'],
  ['合約交流裙'],
  ['顶级交流社区'],
  ['免費跟'],
  ['每天免费', '策略分享'],
  ['每天免費', '策略分享'],
  ['不求一夜暴富', '蒸蒸日上'],
  ['内部群免费', '加入'],
  ['8年合约', '社区'],
  ['高勝率', '返佣'],
  ['社區免費', '直播間'],
  // ── 通用及組合關鍵詞 ──
  ['內部群', '免費'],
  ['内部群', '免费'],
  ['社區', '點位'],
  ['社区', '点位'],
  ['跟單', '免費'],
  ['跟单', '免费'],
  ['跟丹', '免費'],
  ['上車', '帶單'],
  ['返佣', '高勝率'],
  ['返傭', '高勝率'],
  ['直播間', '開播'],
  ['跟單老師', '免費'],
  ['限時活動'],
  ['限时活动'],
  // ── 帶單（copy trading leader）──
  ['带单', '免费'],
  ['帶單', '免費'],
  // ── 帶單 + 跟車組合 ──
  ['带单', '跟车'],
  ['帶單', '跟車'],
  // ── 布局 + 空/多單（crypto position spam）──
  ['布局', '空单'],
  ['布局', '空單'],
  ['佈局', '空單'],
  ['佈局', '空单'],
  ['布局', '多单'],
  ['布局', '多單'],
  ['佈局', '多單'],
  ['佈局', '多单'],
  // ── 空/多單 + 利潤 ──
  ['空单', '利润'],
  ['空單', '利潤'],
  ['多单', '利润'],
  ['多單', '利潤'],
  // ── 實盤 + 帶單 ──
  ['实盘', '带单'],
  ['實盤', '帶單'],
  // ── 合約 + 利潤 / 帶單 ──
  ['合约', '利润'],
  ['合約', '利潤'],
  ['合约', '带单'],
  ['合約', '帶單'],
  // ── 多空信號 ──
  ['多空', '信号'],
  ['多空', '信號'],
  // ── 免費跟單 / 免費跟車 ──
  ['免费', '跟车'],
  ['免費', '跟車'],
  ['免费', '带单'],
  ['免費', '帶單'],
];

// ─── 語言檔 ────────────────────────────────────────────────────
const I18N = {
  zh: {
    welcome: "👋 歡迎新成員！此群組開啟保護模式，*前 5 分鐘禁止發送連結*。",
    forward_kick: "🚫 *禁止轉發訊息*\n此群組不允許轉發外部訊息，已將該成員移出。",
    link_kick: "🚫 *禁止發送連結*\n已將發送連結的成員移出群組。",
    spam_kick: "🚫 *洗版/重複訊息偵測*\n已將發送大量重複訊息的成員移出群組。",
    short_kick: "🚫 *無意義訊息*\n連續發送無意義短訊息，已將該成員移出群組。",
    keyword_kick: "🚫 *疑似招攬廣告*\n訊息含有違禁關鍵詞，已將該成員移出群組。",
    allow: "✅ 已准許域名: *{domain}*",
    disallow: "❌ 已移除域名: *{domain}*",
    allow_user: "✅ 已准許用戶 UID: *{userId}*",
    disallow_user: "❌ 已移除准許用戶 UID: *{userId}*",
    list_header: "📋 **目前白名單規則：**\n",
    list_hard: "\n🏢 **(系統內建規則):**\n",
    list_dyn: "\n🌐 **(動態新增域名):**\n",
    list_users: "\n👤 **(特許用戶):**\n",
    reset_admin: "♻️ 已重置 UID 為 {userId} 的管理快取",
    reset_violations: "♻️ 已清空 UID 為 {userId} 的所有違規紀錄",
    unban: "✅ 已解封 UID: *{userId}*，該用戶可重新加入群組。",
    unban_fail: "⚠️ 解封失敗，請確認 UID 是否正確。",
    export_bans: "📋 **封禁名單：**\n已生成封禁人員名單如下：",
    no_bans: "📭 目前尚無封禁記錄。",
    help: "📕 **管理員常用指令：**\n" +
      "`/allow <domain>` - 放行特定域名\n" +
      "`/disallow <domain>` - 撤回放行域名\n" +
      "`/allowuser <uid>` - 放行特定用戶\n" +
      "`/disallowuser <uid>` - 撤回放行用戶\n" +
      "`/listwhitelist` - 查看所有白名單\n" +
      "`/unban <uid>` - 解封被封禁的成員\n" +
      "`/exportbans` - 匯出所有封禁名冊\n" +
      "`/resetviolations <uid>` - 清空違規紀錄\n" +
      "`/resetadmincache <uid>` - 重置管理員快取\n" +
      "`/help` - 顯示此說明",
    warn_mute_24h: "⚠️ **首次違規警告**\n該用戶已被禁言 **24 小時**。期間仍可發送純文字訊息，但禁止發送連結、轉發與媒體內容。",
    warn_mute_7d: "⚠️ **二次違規警告**\n該用戶已被**完全禁言 7 天**，期間禁止在本群發送任何訊息。",
    kick_final: "🚫 **多次違規處分**\n該用戶已累計 3 次或更多違規，已被永久移出群組。"
  },
  en: {
    welcome: "👋 Welcome! Group protected. *No links for first 5 mins*.",
    forward_kick: "🚫 *No Forwarded Messages*\nForwarding is not allowed. Member removed.",
    link_kick: "🚫 *No Links Allowed*\nMember removed for posting links.",
    spam_kick: "🚫 *Spam Detected*\nMember removed for flooding or duplicate messages.",
    short_kick: "🚫 *Meaningless Messages*\nMember removed for repeatedly sending short meaningless messages.",
    keyword_kick: "🚫 *Suspected Spam*\nMessage contains banned keywords. Member removed.",
    allow: "✅ Allowed: *{domain}*",
    disallow: "❌ Removed: *{domain}*",
    allow_user: "✅ Whitelisted User UID: *{userId}*",
    disallow_user: "❌ Removed Whitelisted User UID: *{userId}*",
    list_header: "📋 **Current Whitelist Rules:**\n",
    list_hard: "\n🏢 **(Built-in Rules):**\n",
    list_dyn: "\n🌐 **(Dynamic Domains):**\n",
    list_users: "\n👤 **(Whitelisted Users):**\n",
    reset_admin: "♻️ Cache reset for UID {userId}",
    unban: "✅ Unbanned UID: *{userId}*. User can rejoin the group.",
    unban_fail: "⚠️ Unban failed. Please check the UID.",
    export_bans: "📋 **Banned List:**\nExported list of banned members:",
    no_bans: "📭 No ban records found.",
    help: "📕 **Admin Commands:**\n" +
      "`/allow <domain>` - Whitelist a domain\n" +
      "`/disallow <domain>` - Remove domain from whitelist\n" +
      "`/allowuser <uid>` - Whitelist a user\n" +
      "`/disallowuser <uid>` - Remove user from whitelist\n" +
      "`/listwhitelist` - See all rules\n" +
      "`/unban <uid>` - Unban a banned member\n" +
      "`/exportbans` - Export banned users list\n" +
      "`/resetadmincache <uid>` - Reset admin cache\n" +
      "`/help` - Show this help"
  }
};

function t(key, data = {}) {
  let str = I18N[CONFIG.LANG][key] || key;
  for (const [k, v] of Object.entries(data)) str = str.replace(`{${k}}`, v);
  return str;
}

// ─── 工具函式 ──────────────────────────────────────────────────

async function callTelegramAPI(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) log('error', `API 失敗: ${method}`, { result, body });
  return result;
}

function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

async function deleteMessage(botToken, chatId, messageId) {
  return callTelegramAPI(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

function sendTemporaryMessage(botToken, chatId, text, ctx) {
  const promise = (async () => {
    const result = await callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    if (result.ok) {
      await new Promise(r => setTimeout(r, 5000));
      await deleteMessage(botToken, chatId, result.result.message_id);
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(promise);
}

// ─── 階梯式處罰（1: 24h禁媒體/連結, 2: 7d全禁, 3: 永久封鎖）───────

async function punishUser(botToken, env, chatId, user, reason, count) {
  if (!user || !user.id) return 'none';
  
  const now = Math.floor(Date.now() / 1000);
  let method = 'restrictChatMember';
  let body = { chat_id: chatId, user_id: user.id };
  let actionType = '';

  if (count === 1) {
    // 第 1 次：24小時禁媒體/連結/轉發（可發純文字）
    body.permissions = {
      can_send_messages: true,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    };
    body.until_date = now + 24 * 3600;
    actionType = 'mute_24h';
  } else if (count === 2) {
    // 第 2 次：7天完全禁言
    body.permissions = {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    };
    body.until_date = now + 7 * 24 * 3600;
    actionType = 'mute_7d';
  } else {
    // 第 3 次或更高：永久封鎖
    method = 'banChatMember';
    actionType = 'ban';
  }

  const result = await callTelegramAPI(botToken, method, body);
  if (!result.ok) log('error', `處罰執行失敗: ${actionType}`, { result, body });

  // 紀錄歷史 (metadata 中保留原始紀錄方便報表抓取)
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Deleted Account';
  await env.TG_GUARD_KV.put(`ban_hist:${chatId}:${user.id}`, `${reason} (${actionType})`, {
    metadata: {
      name,
      username: user.username || '',
      date: new Date().toISOString()
    }
  });
  
  return actionType;
}

// ─── 權限管理 ───────────────────────────────────────────────────

async function getMemberStatus(botToken, env, chatId, userId, senderChat) {
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

async function getDynamicWhitelist(env, chatId) {
  const data = await env.TG_GUARD_KV.get(`whitelist:${chatId}`);
  return data ? JSON.parse(data) : [];
}

async function getDynamicUserWhitelist(env, chatId) {
  const data = await env.TG_GUARD_KV.get(`whitelist_users:${chatId}`);
  return data ? (Array.isArray(JSON.parse(data)) ? JSON.parse(data) : []) : [];
}

// ─── 洗版偵測：頻率限制 + 重複訊息 ─────────────────────────────

function normalizeText(text) {
  if (!text) return '';
  // 移除所有空格、標點符號、換行符，統一口語化字符以便比對
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

async function checkRateLimit(env, chatId, userId) {
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

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return Math.abs(h).toString(16);
}

async function checkDuplicate(env, chatId, userId, text) {
  if (!text || text.trim().length < 10) return false;
  const hash = simpleHash(text.trim().toLowerCase());
  const key = `dup:${chatId}:${userId}:${hash}`;
  const exists = await env.TG_GUARD_KV.get(key);
  if (exists) return true;
  await env.TG_GUARD_KV.put(key, '1', { expirationTtl: CONFIG.DUP_WINDOW });
  return false;
}

// 關鍵詞組合偵測：任一組內所有詞同時出現則命中
function matchesKeywordSet(text) {
  if (!text) return false;
  const normalized = normalizeText(text);

  // 特殊規則：含有 2 個或以上 ✅ (常見於垃圾信息)
  const checkCount = (text.match(/✅/g) || []).length;
  if (checkCount >= 2) return true;

  return KEYWORD_SETS.some(set => {
    // 將關鍵詞也正規化後進行比對，以應對空格/符號規避
    return set.every(kw => normalized.includes(normalizeText(kw)));
  });
}

// ✅ 重複 emoji 偵測：超過 1 個 ✅ 視為垃圾信息
function hasMultiCheckmark(text) {
  if (!text) return false;
  return (text.match(/✅/g) || []).length > 1;
}

// ─── 違規次數追蹤（7 天滑動視窗）──────────────────────────────

async function incrementViolations(env, chatId, userId) {
  const key = `violations:${chatId}:${userId}`;
  const count = parseInt(await env.TG_GUARD_KV.get(key) || '0') + 1;
  await env.TG_GUARD_KV.put(key, count.toString(), { expirationTtl: CONFIG.VIOLATION_TTL });
  return count;
}

// 連續短訊息偵測：訊息字元數 < SHORT_MSG_MIN_LEN 時累計，達到 SHORT_MSG_MAX 則踢出
// 發送正常長度訊息時自動重置計數
async function checkShortMessageSpam(env, chatId, userId, text) {
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

// ─── 核心偵測邏輯 ───────────────────────────────────────────────

function extractUrls(message) {
  const urls = new Set();
  const text = message.text || message.caption || '';
  // 合併 text 與 caption 的 entities，避免 [] 為 truthy 導致 caption_entities 被忽略
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];

  for (const entity of entities) {
    const part = text.substring(entity.offset, entity.offset + entity.length);
    if (entity.type === 'url') urls.add(part);
    else if (entity.type === 'text_link' && entity.url) urls.add(entity.url);
    else if (entity.type === 'mention') urls.add(`https://t.me/${part.substring(1)}`);
  }
  const matches = text.matchAll(CONFIG.REGEX_URL);
  for (const match of matches) {
    const url = match[0];
    if (url.startsWith('@')) urls.add(`https://t.me/${url.substring(1)}`);
    else urls.add(url);
  }
  // 兼容舊版 Bot API 的 web_page 字段（某些 Telegram 版本仍會附帶）
  if (message.web_page?.url) urls.add(message.web_page.url);
  return Array.from(urls);
}

function analyzeMessage(message, dynamicWhitelist) {
  const urls = extractUrls(message);
  let hasTelegram = false;
  let hasSuspicious = false;
  const fullWhitelist = [...ALLOWED_DOMAINS, ...dynamicWhitelist];

  for (const url of urls) {
    try {
      const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
      const urlObj = new URL(normalizedUrl);
      const domain = urlObj.hostname.toLowerCase().replace(/^www\./, '');
      const fullPath = urlObj.pathname.toLowerCase() + urlObj.search.toLowerCase();

      // ── 1. 強制黑名單檢查 (URL) ──
      if (BLACKLISTED_INVITE_LINKS.has(normalizedUrl)) { hasSuspicious = true; break; }

      if (domain === 't.me' || domain === 'telegram.me') {
        const username = fullPath.split('/')[1]?.split(/[?#]/)[0];
        // ── 2. 黑名單用戶名檢查 ──
        if (username && BLACKLISTED_USERNAMES.has(username.replace(/^@/, ''))) { 
          hasTelegram = true; 
          break; 
        }

        // ── 3. 通用邀請連結檢查 (spam 防禦) ──
        const isInvite = fullPath.startsWith('/+') || fullPath.includes('/joinchat/');
        if (isInvite) {
          // 排除白名單關鍵字
          const isKeywordAllowed = ALLOWED_TELEGRAM_KEYWORDS.some(k => fullPath.includes(k.toLowerCase()));
          if (!isKeywordAllowed) { hasTelegram = true; break; }
        }
        // 准許普通 @username 或頻道連結
      } else if (domain !== 'telegram.org') {
        // ── 4. 外部域名檢查 ──
        // 如果不在白名單且是「可疑」行為（此處可根據需求調整，目前用戶要求放行其他鏈接）
        // 我們僅在特定情況下標記 Suspicious，否則准許
        const isWhitelisted = fullWhitelist.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
        // hasSuspicious = false; // 默認准許
      }
    } catch { }
  }
  return { hasTelegram, hasSuspicious, foundUrls: urls };
}

// ─── 管理員日誌通知 ─────────────────────────────────────────────

async function notifyAdminLog(botToken, env, { chatId, userId, username, foundUrls, reason, originalText, count }) {
  const adminId = env.ADMIN_ID;
  if (!adminId) return;

  // ─── 存儲紀錄 ───
  try {
    const now = new Date();
    const timestamp = now.getTime();
    const isoDate = now.toISOString();
    const logKey = `vlog:${timestamp}:${userId}`;
    const logEntry = {
      date: isoDate.split('T')[0],
      timestamp: isoDate,
      userId,
      username: username || 'N/A',
      reason,
      originalText: originalText || '',
      count
    };
    await env.TG_GUARD_KV.put(logKey, JSON.stringify(logEntry));
  } catch (e) {
    log('error', '儲存違規紀錄失敗', { error: e.message });
  }

  // ─── 發送通知 ───
  const reasonMap = { forward: '轉發訊息', link: '發送連結', keyword: '關鍵詞黑名單', spam: '洗版/重複', short: '無意義短訊息' };
  const preview = originalText
    ? `\n📝 原文: \`${originalText.slice(0, 100)}${originalText.length > 100 ? '…' : ''}\``
    : '';
  const txt = `🚨 **違規活動記錄**\n\n` +
    `📍 群組: \`${chatId}\`\n` +
    `👤 用戶: \`${userId}\` (${username || '無名氏'})\n` +
    `⚡ 原因: ${reasonMap[reason] || reason}` +
    preview +
    `\n🔗 內容: \`${foundUrls.join(', ')}\`` +
    `\n⚠️ 累計次數: ${count}`;
  await callTelegramAPI(botToken, 'sendMessage', { chat_id: adminId, text: txt, parse_mode: 'Markdown' });
}

// ─── 生成 CSV 報表 ─────────────────────────────────────────────

async function generateViolationCSV(env) {
  let allLogs = [];
  
  // ─── 1. 獲取新版詳細紀錄 (vlog:) ───
  let cursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'vlog:', cursor });
    for (const key of list.keys) {
      const val = await env.TG_GUARD_KV.get(key.name);
      if (val) {
        try { allLogs.push(JSON.parse(val)); } catch (e) {}
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // ─── 2. 獲取舊版紀錄 (ban_hist:) 並合併 ───
  let banCursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'ban_hist:', cursor: banCursor });
    for (const key of list.keys) {
      const parts = key.name.split(':');
      const userId = parts.pop();
      const chatId = parts.pop();
      
      // 避免重複（如果已經在 vlog 中有了）
      if (allLogs.some(l => String(l.userId) === String(userId))) continue;

      const reason = await env.TG_GUARD_KV.get(key.name);
      const m = key.metadata || {};
      const count = await env.TG_GUARD_KV.get(`violations:${chatId}:${userId}`) || '1';

      allLogs.push({
        date: m.date ? m.date.split('T')[0] : '歷史',
        timestamp: m.date || '1970-01-01T00:00:00Z',
        userId: userId,
        username: m.username ? `${m.name} (@${m.username})` : m.name || 'N/A',
        reason: reason || 'Unknown',
        originalText: '(舊版歷史，無原文預覽)',
        count: count
      });
    }
    banCursor = list.list_complete ? undefined : list.cursor;
  } while (banCursor);

  // ─── 3. 排序並生成 CSV 內容 ───
  allLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const header = '\uFEFF日期,用戶號,用戶名,原因,原文內容,累計次數\n';
  const rows = allLogs.map(log => {
    const date = log.date || '';
    const uid = log.userId || '';
    const uname = (log.username || '').replace(/"/g, '""');
    const reason = log.reason || '';
    const content = (log.originalText || '').replace(/"/g, '""').replace(/\n/g, ' ');
    const count = log.count || '';
    return `"${date}","${uid}","${uname}","${reason}","${content}","${count}"`;
  }).join('\n');

  return header + rows;
}

async function sendCSVDoc(botToken, adminId, csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('chat_id', adminId);
  formData.append('document', blob, filename);

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const response = await fetch(url, { method: 'POST', body: formData });
  return await response.json();
}

// ─── 管理員指令 ─────────────────────────────────────────────────

async function handleAdminCommands(botToken, env, ctx, message, status) {
  const isAdmin = status === 'creator' || status === 'administrator';
  if (!isAdmin) return false;

  const rawText = message.text || '';
  const chatId = message.chat.id;
  const text = rawText.replace(/\/\w+@\w+/, (m) => m.split('@')[0]);

  const cmdPrefixes = ['/allow ', '/disallow ', '/allowuser ', '/disallowuser ', '/listwhitelist', '/unban ', '/exportbans', '/resetviolations ', '/resetadmincache', '/help', '/exportall', '/getexporturl'];
  const matched = cmdPrefixes.some(p => text.startsWith(p) || text === p.trim());
  if (!matched) return false;

  if (message.chat.type !== 'private') {
    ctx.waitUntil(deleteMessage(botToken, chatId, message.message_id));
  }

  const sendMessage = (txt) => {
    if (message.chat.type === 'private') {
      return callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text: txt, parse_mode: 'Markdown' });
    } else {
      return sendTemporaryMessage(botToken, chatId, txt, ctx);
    }
  };

  if (text.startsWith('/allow ')) {
    const domain = text.split(' ')[1]?.toLowerCase();
    if (domain) {
      const current = await getDynamicWhitelist(env, chatId);
      if (!current.includes(domain)) {
        current.push(domain);
        await env.TG_GUARD_KV.put(`whitelist:${chatId}`, JSON.stringify(current));
      }
      sendMessage(t('allow', { domain }));
    }
  } else if (text.startsWith('/disallow ')) {
    const domain = text.split(' ')[1]?.toLowerCase();
    if (domain) {
      const dyn = await getDynamicWhitelist(env, chatId);
      await env.TG_GUARD_KV.put(`whitelist:${chatId}`, JSON.stringify(dyn.filter(d => d !== domain)));
      sendMessage(t('disallow', { domain }));
    }
  } else if (text.startsWith('/allowuser ')) {
    const uid = parseInt(text.split(' ')[1]);
    if (uid) {
      const current = await getDynamicUserWhitelist(env, chatId);
      if (!current.includes(uid)) {
        current.push(uid);
        await env.TG_GUARD_KV.put(`whitelist_users:${chatId}`, JSON.stringify(current));
      }
      sendMessage(t('allow_user', { userId: uid }));
    }
  } else if (text.startsWith('/disallowuser ')) {
    const uid = parseInt(text.split(' ')[1]);
    if (uid) {
      const dyn = await getDynamicUserWhitelist(env, chatId);
      await env.TG_GUARD_KV.put(`whitelist_users:${chatId}`, JSON.stringify(dyn.filter(id => id !== uid)));
      sendMessage(t('disallow_user', { userId: uid }));
    }
  } else if (text === '/listwhitelist') {
    const dyn = await getDynamicWhitelist(env, chatId);
    const dynUsers = await getDynamicUserWhitelist(env, chatId);
    let out = t('list_header');
    if (ALLOWED_DOMAINS.length || ALLOWED_TELEGRAM_KEYWORDS.length) {
      const hard = [...ALLOWED_DOMAINS, ...ALLOWED_TELEGRAM_KEYWORDS.map(k => `t.me/${k}`)];
      out += t('list_hard') + hard.map(d => `• ${d}`).join('\n') + '\n';
    }
    out += t('list_dyn') + (dyn.length > 0 ? dyn.map(d => `• ${d}`).join('\n') : '(Empty)') + '\n';
    
    // 列表化特許用戶
    const hardUsers = Array.from(WHITELISTED_USER_IDS);
    out += t('list_users') + [...hardUsers, ...dynUsers].map(u => `• ${u}`).join('\n');
    
    sendMessage(out);
  } else if (text.startsWith('/unban ')) {
    const uid = parseInt(text.split(' ')[1]);
    if (uid) {
      const result = await callTelegramAPI(botToken, 'unbanChatMember', { chat_id: chatId, user_id: uid, only_if_banned: true });
      sendMessage(result.ok ? t('unban', { userId: uid }) : t('unban_fail'));
    }
  } else if (text.startsWith('/resetviolations ')) {
    const uid = text.split(' ')[1];
    if (uid) {
      await env.TG_GUARD_KV.delete(`violations:${chatId}:${uid}`);
      sendMessage(t('reset_violations', { userId: uid }));
    }
  } else if (text.startsWith('/resetadmincache')) {
    const uid = text.split(' ')[1] || message.from.id;
    await env.TG_GUARD_KV.delete(`admin_cache:${chatId}:${uid}`);
    sendMessage(t('reset_admin', { userId: uid }));
  } else if (text.startsWith('/exportbans')) {
    const isPrivate = message.chat.type === 'private';
    const prefix = isPrivate ? 'ban_hist:' : `ban_hist:${chatId}:`;

    let allKeys = [];
    let cursor;
    do {
      const listOpts = cursor ? { prefix, cursor } : { prefix };
      const list = await env.TG_GUARD_KV.list(listOpts);
      allKeys.push(...list.keys);
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    if (allKeys.length === 0) {
      const oldPrefix = isPrivate ? 'violations:' : `violations:${chatId}:`;
      const oldList = await env.TG_GUARD_KV.list({ prefix: oldPrefix });
      if (oldList.keys.length === 0) {
        sendMessage(t('no_bans'));
      } else {
        let out = t('export_bans') + "\n\n(前代記錄，僅含 UID)\n";
        for (const k of oldList.keys) {
          const parts = k.name.split(':');
          const uid = parts.pop();
          const cid = parts.pop();
          out += `• Group: ${cid} | UID: ${uid}\n`;
        }
        sendMessage(out);
      }
    } else {
      let out = t('export_bans') + "\n\n";
      const records = allKeys.map(k => {
        const parts = k.name.split(':');
        return {
          uid: parts.pop(),
          cid: parts.pop(),
          ...k.metadata
        };
      }).sort((a, b) => new Date(a.date) - new Date(b.date));

      for (const r of records) {
        const d = r.date ? r.date.split('T')[0] : 'Unknown';
        const groupInfo = isPrivate ? `[${r.cid}] ` : '';
        out += `• ${d} | ${groupInfo}${r.name} (${r.uid})${r.username ? ' @' + r.username : ''}\n`;
      }

      if (out.length > 4000) {
        const chunks = out.match(/[\s\S]{1,4000}/g);
        for (const chunk of chunks) {
          await callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text: chunk });
        }
      } else {
        await callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text: out });
      }
    }
  } else if (text === '/exportall') {
    const csv = await generateViolationCSV(env);
    const result = await sendCSVDoc(botToken, message.from.id, csv, `violation_report_${new Date().toISOString().split('T')[0]}.csv`);
    if (!result.ok) {
        sendMessage(`❌ 匯出失敗: ${result.description}`);
    }
  } else if (text === '/getexporturl') {
    const secret = env.EXPORT_SECRET || 'PLEASE_SET_EXPORT_SECRET';
    const host = message.chat.type === 'private' ? 'https://your-worker-url.workers.dev' : ''; // 這裡無法精確得知 URL，提示用戶
    sendMessage(`🌐 **累積違規報表下載連結：**\n\n請造訪以下網址（建議電腦開啟）：\n\`${host}/export?token=${secret}\`\n\n⚠️ *請將網址中的 your-worker-url 替換為您的 Worker 實際網址。*`);
  } else if (text === '/help') {
    sendMessage(t('help'));
  }
  return true;
}

// ─── 訊息處理核心 ───────────────────────────────────────────────

async function handleMessage(botToken, env, ctx, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id ?? null;
  const senderChat = message.sender_chat;

  // 私聊處理：僅允許 ADMIN_ID 使用管理指令
  if (message.chat.type === 'private') {
    if (userId && String(userId) === String(env.ADMIN_ID)) {
      await handleAdminCommands(botToken, env, ctx, message, 'administrator');
    }
    return;
  }

  // 系統帳號（GroupAnonymousBot 等）以及特許用戶直接豁免
  const dynUserWhitelist = await getDynamicUserWhitelist(env, chatId);
  const isWhitelistedUser = userId && (WHITELISTED_USER_IDS.has(userId) || dynUserWhitelist.includes(userId));

  if (userId && (SYSTEM_BOT_IDS.has(userId) || isWhitelistedUser)) return;

  const memberStatus = await getMemberStatus(botToken, env, chatId, userId, senderChat);
  if (message.text?.startsWith('/') && await handleAdminCommands(botToken, env, ctx, message, memberStatus)) return;
  if (memberStatus === 'creator' || memberStatus === 'administrator') return;

  // 合併所有可偵測文字：訊息本體 + 引用回覆 + 轉發來源頻道名稱
  const originalText = [
    message.text,
    message.caption,
    message.reply_to_message?.text,
    message.reply_to_message?.caption,
    message.forward_origin?.chat?.title,
    message.forward_from_chat?.title,
  ].filter(Boolean).join(' ');

  // ── 規則 1：任何轉發訊息 → 刪除訊息並封禁（已刪除帳號只刪訊息）──
  // 檢查傳統 forward_* 欄位、新版 forward_origin，以及引用回覆外部頻道（quote reply bypass）
  const repliedToExternal = message.reply_to_message?.forward_from_chat
    || message.reply_to_message?.sender_chat
    || message.reply_to_message?.forward_origin;
  const isForwarded = message.forward_origin || message.forward_date || message.forward_from || message.forward_from_chat || message.forward_sender_name || repliedToExternal;
  if (isForwarded && !SYSTEM_BOT_IDS.has(userId)) {
    const origin = message.forward_origin || {};
    const replyOrigin = message.reply_to_message?.forward_origin || {};
    const replySenderChat = message.reply_to_message?.sender_chat;
    const replyForwardChat = message.reply_to_message?.forward_from_chat;
    const forwardSrc = origin.chat?.title || origin.sender_user?.first_name || origin.type
      || message.forward_from_chat?.title || message.forward_from?.first_name
      || replyOrigin.chat?.title || replyOrigin.sender_user?.first_name
      || replySenderChat?.title || replyForwardChat?.title || 'unknown';
    log('info', 'Forward 違規', { chatId, userId, forwardSrc });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      const count = await incrementViolations(env, chatId, userId);
      const actionType = await punishUser(botToken, env, chatId, message.from, 'forward', count);
      const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';
      
      ctx.waitUntil(Promise.all([
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [`[forwarded from: ${forwardSrc}]`], reason: 'forward', originalText, count })
      ]));
      sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
    }
    return;
  }

  // ── 規則 2：關鍵詞組合偵測 / 多✅emoji → 立即封禁 ──────────
  if (matchesKeywordSet(originalText) || hasMultiCheckmark(originalText)) {
    log('info', 'Keyword 違規', { chatId, userId, originalText: originalText.slice(0, 80) });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      const count = await incrementViolations(env, chatId, userId);
      const actionType = await punishUser(botToken, env, chatId, message.from, 'keyword', count);
      const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';
      
      ctx.waitUntil(Promise.all([
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [], reason: 'keyword', originalText, count })
      ]));
      sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
    }
    return;
  }

  // ── 規則 3：連結偵測 → 立即封禁（無警告）────────────────────
  const dynWhitelist = await getDynamicWhitelist(env, chatId);
  const { hasTelegram, hasSuspicious, foundUrls } = analyzeMessage(message, dynWhitelist);

  if (hasTelegram || hasSuspicious) {
    log('info', 'Link 違規', { chatId, userId, foundUrls });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      const count = await incrementViolations(env, chatId, userId);
      const actionType = await punishUser(botToken, env, chatId, message.from, 'link', count);
      const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';

      ctx.waitUntil(Promise.all([
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls, reason: 'link', originalText, count })
      ]));
      sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
    }
    return;
  }

  // ── 規則 3：洗版偵測（無 userId 無法追蹤，跳過）────────────────
  if (!userId) return;
  const [isRateLimited, isDuplicate, isShortSpam] = await Promise.all([
    checkRateLimit(env, chatId, userId),
    checkDuplicate(env, chatId, userId, originalText),
    checkShortMessageSpam(env, chatId, userId, originalText)
  ]);

  if (isRateLimited || isDuplicate || isShortSpam) {
    const spamReason = isShortSpam ? '[short_msg]' : isRateLimited ? '[rate_limit]' : '[duplicate]';
    const logReason = isShortSpam ? 'short' : 'spam';
    const kickMsg = isShortSpam ? t('short_kick') : t('spam_kick');
    log('info', 'Spam 違規封禁', { chatId, userId, spamReason });
    await deleteMessage(botToken, chatId, message.message_id);
    const count = await incrementViolations(env, chatId, userId);
    const actionType = await punishUser(botToken, env, chatId, message.from, logReason, count);
    const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';

    ctx.waitUntil(Promise.all([
      notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [spamReason], reason: logReason, originalText, count })
    ]));
    sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
  }
}

// ─── 入口 ──────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // ─── 網頁匯出處理 ───
    if (url.pathname === '/export') {
      const token = url.searchParams.get('token');
      if (!env.EXPORT_SECRET || token !== env.EXPORT_SECRET) {
        return new Response('Unauthorized', { status: 403 });
      }
      const csv = await generateViolationCSV(env);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="all_violations_${new Date().toISOString().split('T')[0]}.csv"`
        }
      });
    }

    if (request.method !== 'POST') return new Response('OK', { status: 200 });
    const botToken = env.BOT_TOKEN;
    if (!botToken) return new Response('Miss BOT_TOKEN', { status: 500 });
    
    // ... 後續邏輯
    if (env.WEBHOOK_SECRET_TOKEN && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const msg = update.message || update.edited_message || update.channel_post;
      if (msg) {
        if (msg.new_chat_members) {
          const chatId = msg.chat.id;
          const cooldownKey = `welcome_cooldown:${chatId}`;
          const isCooling = await env.TG_GUARD_KV.get(cooldownKey);
          if (!isCooling) {
            await env.TG_GUARD_KV.put(cooldownKey, '1', { expirationTtl: CONFIG.WELCOME_COOLDOWN_SEC });
            sendTemporaryMessage(botToken, chatId, t('welcome'), ctx);
          }
        }
        if (!msg.new_chat_members && !msg.left_chat_member && !msg.pinned_message) {
          await handleMessage(botToken, env, ctx, msg);
        }
      }
    } catch (e) { log('error', 'Runtime Error', { error: e.message }); }
    return new Response('OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const botToken = env.BOT_TOKEN;
    const adminId = env.ADMIN_ID;
    if (!botToken || !adminId) return;

    try {
      const csv = await generateViolationCSV(env);
      await sendCSVDoc(botToken, adminId, csv, `daily_all_history_${new Date().toISOString().split('T')[0]}.csv`);
      log('info', '每日全量報表已發送');
    } catch (e) {
      log('error', '每日報表發送失敗', { error: e.message });
    }
  }
};
