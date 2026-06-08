import { CONFIG, KEYWORD_SETS, BLACKLISTED_INVITE_LINKS, BLACKLISTED_USERNAMES, WHITELISTED_DOMAINS } from './config.js';
import { normalizeText } from './utils.js';

// 關鍵詞組合偵測：任一組內所有詞同時出現則命中
// keywordSets 可選，預設使用 config 中的 KEYWORD_SETS；可傳入合併後的列表
export function matchesKeywordSet(text, keywordSets = KEYWORD_SETS) {
  if (!text) return false;
  const normalized = normalizeText(text);

  // 特殊規則：含有 4 個或以上 ✅ (常見於垃圾信息)
  const checkCount = (text.match(/✅/g) || []).length;
  if (checkCount >= 4) return true;

  return keywordSets.some(set => {
    if (!Array.isArray(set) || set.length === 0) return false;
    // 將關鍵詞也正規化後進行比對，以應對空格/符號規避
    return set.every(kw => normalized.includes(normalizeText(kw)));
  });
}

// ✅ 重複 emoji 偵測：超過 1 個 ✅ 視為垃圾信息
export function hasMultiCheckmark(text) {
  if (!text) return false;
  return (text.match(/✅/g) || []).length > 1;
}

// 無意義噪音訊息偵測：純數字 / 純字母 / 單字重複 / 數字字母亂碼
// （機器人常見手法：每隔一段時間發一條 "879"、"9527" 之類的填充訊息）
// 為降低誤殺，僅針對「不含中日韓文字、長度短」的訊息；
// 真正的處罰由 store.checkNoiseSpam 的「遇正常訊息即清零」長窗計數器把關，
// 因此偶爾發一句 "666" / "ok" 並不會被處理。
export function isNoiseMessage(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 含中日韓文字 → 視為有意義（"好的"、"哈哈" 等正常短回覆）
  if (/[一-鿿぀-ヿ가-힯]/.test(trimmed)) return false;

  // 單一字元重複 ≥3 次（1111、aaaa、。。。、====）
  if (/^(.)\1{2,}$/u.test(trimmed)) return true;

  // 去除空白 / 標點 / 符號後的核心內容
  const core = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!core) return false;            // 純符號 / 純 emoji → 不處理（避免誤殺表情回覆）
  if (core.length > 12) return false; // 較長內容視為正常句子

  // 純數字（879、9527）
  if (/^\d+$/.test(core)) return true;
  // 純英文字母短串（asdf、qweqwe…）
  if (/^[a-zA-Z]+$/.test(core)) return true;
  // 數字 + 字母混合的短亂碼（a1b2、x9k…）
  if (/^[a-zA-Z0-9]+$/.test(core) && /\d/.test(core) && /[a-zA-Z]/.test(core)) return true;

  return false;
}

// 回傳 [{ url, isMention }]：
//   isMention=true  → 單純 @用戶名 提及（例如 @群友），社交行為
//   isMention=false → 真實連結（http、t.me 邀請、寫出來的 t.me/xxx、外部域名等）
// 仍會把 mention 轉成 t.me 連結以便比對黑名單用戶名，但用 isMention 標記區分用途。
export function extractUrls(message) {
  const map = new Map(); // url → isMention（同一 url 若同時來自真連結與提及，真連結優先）
  const add = (url, isMention) => {
    if (map.has(url)) { if (!isMention) map.set(url, false); }
    else map.set(url, isMention);
  };
  const text = message.text || message.caption || '';
  // 合併 text 與 caption 的 entities，避免 [] 為 truthy 導致 caption_entities 被忽略
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];

  for (const entity of entities) {
    const part = text.substring(entity.offset, entity.offset + entity.length);
    if (entity.type === 'url') add(part, false);
    else if (entity.type === 'text_link' && entity.url) add(entity.url, false);
    else if (entity.type === 'mention') add(`https://t.me/${part.substring(1)}`, true);
  }
  const matches = text.matchAll(CONFIG.REGEX_URL);
  for (const match of matches) {
    const url = match[0];
    if (url.startsWith('@')) add(`https://t.me/${url.substring(1)}`, true);
    else add(url, false);
  }
  // 兼容舊版 Bot API 的 web_page 字段（某些 Telegram 版本仍會附帶）
  if (message.web_page?.url) add(message.web_page.url, false);
  return Array.from(map, ([url, isMention]) => ({ url, isMention }));
}

// blacklistedLinks / blacklistedUsernames 為合併後的 Set，由呼叫端組合 config + KV
export function analyzeMessage(
  message,
  dynamicWhitelist,
  blacklistedLinks = BLACKLISTED_INVITE_LINKS,
  blacklistedUsernames = BLACKLISTED_USERNAMES
) {
  const urls = extractUrls(message);
  let hasTelegram = false;
  let hasSuspicious = false;
  let hasExternalLink = false; // 含「非白名單外部域名」連結：老用戶據此僅刪除（不處罰）
  // 是否含「真實連結」（非單純 @提及）：新人保護期據此判斷，@群友放行
  const hasRealLink = urls.some(u => !u.isMention);
  // 合併：群組動態白名單（/allow）+ 內建常用大站白名單
  const fullWhitelist = [...dynamicWhitelist, ...WHITELISTED_DOMAINS];

  for (const { url } of urls) {
    try {
      const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
      const urlObj = new URL(normalizedUrl);
      const domain = urlObj.hostname.toLowerCase().replace(/^www\./, '');
      const fullPath = urlObj.pathname.toLowerCase() + urlObj.search.toLowerCase();

      // ── 1. 強制黑名單检查 (URL) ──
      // 改用「包含」檢查，防止參數規避 (?start= 等)
      const isBlacklistedLink = Array.from(blacklistedLinks).some(link => normalizedUrl.includes(link));
      if (isBlacklistedLink) { hasSuspicious = true; break; }

      if (domain === 't.me' || domain === 'telegram.me') {
        const username = fullPath.split('/')[1]?.split(/[?#]/)[0];
        // ── 2. 黑名單用戶名檢查 ──
        if (username && blacklistedUsernames.has(username.replace(/^@/, ''))) {
          hasTelegram = true;
          break;
        }

        // ── 3. 通用邀請連結檢查 (spam 防禦) ──
        const isInvite = fullPath.startsWith('/joinchat/') || fullPath.startsWith('/+');
        if (isInvite) {
          hasTelegram = true; break;
        }
        // 准許普通 @username 或頻道連結
      } else if (domain !== 'telegram.org') {
        // ── 4. 外部域名檢查：非白名單外鏈標記，由呼叫端決定是否刪除 ──
        const isWhitelisted = fullWhitelist.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
        if (!isWhitelisted) hasExternalLink = true;
      }
    } catch { }
  }
  return { hasTelegram, hasSuspicious, hasExternalLink, hasRealLink, foundUrls: urls.map(u => u.url) };
}
