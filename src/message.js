import {
  SYSTEM_BOT_IDS,
  WHITELISTED_USER_IDS,
  BLACKLISTED_FORWARD_SOURCES,
  BLACKLISTED_INVITE_LINKS,
  BLACKLISTED_USERNAMES,
  KEYWORD_SETS
} from './config.js';
import { t } from './i18n.js';
import { log, callTelegramAPI, deleteMessage, sendTemporaryMessage } from './utils.js';
import {
  getDynamicUserWhitelist,
  getMemberStatus,
  incrementViolations,
  getDynamicWhitelist,
  checkRateLimit,
  checkDuplicate,
  checkShortMessageSpam,
  isUserInCooldown,
  getCustomBlacklist
} from './store.js';
import { matchesKeywordSet, hasMultiCheckmark, analyzeMessage } from './detector.js';
import { punishUser, notifyAdminLog } from './moderation.js';
import { handleAdminCommands } from './admin.js';
import { checkCAS } from './cas.js';

export async function handleMessage(botToken, env, ctx, message) {
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

  // ── 規則 0a：sender_chat 外部頻道身份發言 → 直接刪 + 封禁該頻道 ──
  // 必須在 SYSTEM_BOT_IDS 早返之前，因為這類訊息的 message.from 是 Channel_Bot (136817688)
  // 例外：
  //   - senderChat.id === chatId  ：匿名管理員（本群自身）→ 放行，後續由 admin 判定處理
  //   - is_automatic_forward      ：連動頻道自動轉發到討論組 → 放行
  if (senderChat && senderChat.id !== chatId && !message.is_automatic_forward) {
    log('info', 'sender_chat 外部頻道發言攔截', { chatId, senderChatId: senderChat.id, title: senderChat.title });
    await deleteMessage(botToken, chatId, message.message_id);
    await callTelegramAPI(botToken, 'banChatSenderChat', { chat_id: chatId, sender_chat_id: senderChat.id });
    ctx.waitUntil(
      notifyAdminLog(botToken, env, {
        chatId, userId: senderChat.id, username: senderChat.username || senderChat.title,
        foundUrls: [`[sender_chat: ${senderChat.title}]`], reason: 'sender_chat',
        originalText: message.text || message.caption || '', count: 3
      })
    );
    sendTemporaryMessage(botToken, chatId, t('kick_final'), ctx);
    return;
  }

  // 系統帳號（GroupAnonymousBot 等）以及特許用戶直接豁免
  const dynUserWhitelist = await getDynamicUserWhitelist(env, chatId);
  const isWhitelistedUser = userId && (WHITELISTED_USER_IDS.has(userId) || dynUserWhitelist.includes(userId));

  if (userId && (SYSTEM_BOT_IDS.has(userId) || isWhitelistedUser)) return;

  const memberStatus = await getMemberStatus(botToken, env, chatId, userId, senderChat);
  if (message.text?.startsWith('/') && await handleAdminCommands(botToken, env, ctx, message, memberStatus)) return;
  if (memberStatus === 'creator' || memberStatus === 'administrator') return;

  // ── 規則 0b：CAS 聯邦封禁庫查詢 → 命中即永封 ──
  if (userId) {
    const cas = await checkCAS(env, userId);
    if (cas.banned) {
      log('info', 'CAS 命中', { chatId, userId, offenses: cas.offenses });
      await deleteMessage(botToken, chatId, message.message_id);
      await punishUser(botToken, env, chatId, message.from, 'cas', 3);
      ctx.waitUntil(
        notifyAdminLog(botToken, env, {
          chatId, userId, username: message.from?.username,
          foundUrls: [`[CAS offenses: ${cas.offenses}]`], reason: 'cas',
          originalText: message.text || message.caption || '', count: 3
        })
      );
      sendTemporaryMessage(botToken, chatId, t('kick_final'), ctx);
      return;
    }
  }

  // 合併所有可偵測文字：訊息本體 + 引用回覆 + 轉發來源頻道名稱
  const originalText = [
    message.text,
    message.caption,
    message.reply_to_message?.text,
    message.reply_to_message?.caption,
    message.forward_origin?.chat?.title,
    message.forward_from_chat?.title,
  ].filter(Boolean).join(' ');

  // 合併動態黑名單（code 默認 + KV 自訂）
  const [customLinks, customUsers, customForwards, customKws] = await Promise.all([
    getCustomBlacklist(env, 'link'),
    getCustomBlacklist(env, 'user'),
    getCustomBlacklist(env, 'forward'),
    getCustomBlacklist(env, 'kw')
  ]);
  const mergedLinks = new Set([...BLACKLISTED_INVITE_LINKS, ...customLinks]);
  const mergedUsers = new Set([...BLACKLISTED_USERNAMES, ...customUsers]);
  const mergedForwards = [...BLACKLISTED_FORWARD_SOURCES, ...customForwards];
  const mergedKws = [...KEYWORD_SETS, ...customKws];

  // ── 規則 1：任何轉發訊息 → 黑名單來源直接永封 ──
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
    const isMaliciousSource = mergedForwards.some(kw => forwardSrc.includes(kw));

    if (isMaliciousSource && userId) {
      log('info', 'Forward 黑名單來源攔截', { chatId, userId, forwardSrc });
      await deleteMessage(botToken, chatId, message.message_id);

      const count = 3;
      const reason = 'banned_source';
      await punishUser(botToken, env, chatId, message.from, reason, count);

      ctx.waitUntil(Promise.all([
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [`[forwardSrc: ${forwardSrc}]`], reason, originalText, count })
      ]));
      sendTemporaryMessage(botToken, chatId, t('kick_final'), ctx);
      return;
    }
  }

  // ── 規則 2：關鍵詞組合偵測 / 多✅emoji → 立即封禁 ──────────
  if (matchesKeywordSet(originalText, mergedKws) || hasMultiCheckmark(originalText)) {
    log('info', 'Keyword 違規', { chatId, userId, originalText: originalText.slice(0, 80) });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      const inCooldown = await isUserInCooldown(env, chatId, userId);
      // 新人保護期內觸發關鍵詞 → 直接永久封禁
      const count = inCooldown ? 3 : await incrementViolations(env, chatId, userId);
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
  let { hasTelegram, hasSuspicious, foundUrls } = analyzeMessage(message, dynWhitelist, mergedLinks, mergedUsers);

  const inCooldown = userId ? await isUserInCooldown(env, chatId, userId) : false;
  if (inCooldown && foundUrls.length > 0) {
    log('info', '新人保護期發連結 → 直接永久封禁', { chatId, userId, foundUrls });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      await punishUser(botToken, env, chatId, message.from, 'link_newuser', 3);
      ctx.waitUntil(
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls, reason: 'link_newuser', originalText, count: 3 })
      );
      sendTemporaryMessage(botToken, chatId, t('kick_final'), ctx);
    }
    return;
  }

  if (hasTelegram || hasSuspicious) {
    log('info', 'Link 違規', { chatId, userId, foundUrls });
    await deleteMessage(botToken, chatId, message.message_id);
    if (userId) {
      const count = inCooldown ? 3 : await incrementViolations(env, chatId, userId);
      const actionType = await punishUser(botToken, env, chatId, message.from, 'link', count);
      const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';

      ctx.waitUntil(
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls, reason: 'link', originalText, count })
      );
      sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
    }
    return;
  }

  // ── 規則 4：洗版偵測 ────────────────
  if (!userId) return;
  const [isRateLimited, isDuplicate, isShortSpam] = await Promise.all([
    checkRateLimit(env, chatId, userId),
    checkDuplicate(env, chatId, userId, originalText),
    checkShortMessageSpam(env, chatId, userId, originalText)
  ]);

  // ── 無意義短訊息：走廣告計數器（圖中反覆發 "5" 的行為）──
  if (isShortSpam) {
    log('info', '無意義短訊息攔截（進入計數器）', { chatId, userId });
    await deleteMessage(botToken, chatId, message.message_id);
    const count = await incrementViolations(env, chatId, userId);
    const actionType = await punishUser(botToken, env, chatId, message.from, 'short', count);
    const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';

    ctx.waitUntil(
      notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: ['[short_msg]'], reason: 'short', originalText, count })
    );
    sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
    return;
  }

  if (isRateLimited || isDuplicate) {
    const spamReason = isRateLimited ? '[rate_limit]' : '[duplicate]';
    log('info', 'Spam 違規', { chatId, userId, spamReason });
    await deleteMessage(botToken, chatId, message.message_id);
    const count = await incrementViolations(env, chatId, userId);
    const actionType = await punishUser(botToken, env, chatId, message.from, 'spam', count);
    const warnKey = actionType === 'mute_24h' ? 'warn_mute_24h' : actionType === 'mute_7d' ? 'warn_mute_7d' : 'kick_final';

    ctx.waitUntil(
      notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [spamReason], reason: 'spam', originalText, count })
    );
    sendTemporaryMessage(botToken, chatId, t(warnKey), ctx);
  }
}
