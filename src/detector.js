import { CONFIG, KEYWORD_SETS, BLACKLISTED_INVITE_LINKS, BLACKLISTED_USERNAMES } from './config.js';
import { normalizeText } from './utils.js';

// 關鍵詞組合偵測：任一組內所有詞同時出現則命中
export function matchesKeywordSet(text) {
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
export function hasMultiCheckmark(text) {
  if (!text) return false;
  return (text.match(/✅/g) || []).length > 1;
}

export function extractUrls(message) {
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

export function analyzeMessage(message, dynamicWhitelist) {
  const urls = extractUrls(message);
  let hasTelegram = false;
  let hasSuspicious = false;
  const fullWhitelist = [...dynamicWhitelist];

  for (const url of urls) {
    try {
      const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
      const urlObj = new URL(normalizedUrl);
      const domain = urlObj.hostname.toLowerCase().replace(/^www\./, '');
      const fullPath = urlObj.pathname.toLowerCase() + urlObj.search.toLowerCase();

      // ── 1. 強制黑名單检查 (URL) ──
      if (BLACKLISTED_INVITE_LINKS.has(normalizedUrl)) { hasSuspicious = true; break; }

      if (domain === 't.me' || domain === 'telegram.me') {
        const username = fullPath.split('/')[1]?.split(/[?#]/)[0];
        // ── 2. 黑名單用戶名檢查 ──
        if (username && BLACKLISTED_USERNAMES.has(username.replace(/^@/, ''))) { 
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
        // ── 4. 外部域名檢查 ──
        // 如果不在白名單且是「可疑」行為（此處可根据需求調整，目前用戶要求放行其他鏈接）
        // 我們僅在特定情況下標記 Suspicious，否則准許
        const isWhitelisted = fullWhitelist.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
        // hasSuspicious = false; // 默認准許
      }
    } catch { }
  }
  return { hasTelegram, hasSuspicious, foundUrls: urls };
}
