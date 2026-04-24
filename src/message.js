import { SYSTEM_BOT_IDS, WHITELISTED_USER_IDS, BLACKLISTED_FORWARD_SOURCES } from './config.js';
import { t } from './i18n.js';
import { log, deleteMessage, sendTemporaryMessage } from './utils.js';
import { 
  getDynamicUserWhitelist, 
  getMemberStatus, 
  incrementViolations, 
  getDynamicWhitelist, 
  checkRateLimit, 
  checkDuplicate, 
  checkShortMessageSpam 
} from './store.js';
import { matchesKeywordSet, hasMultiCheckmark, analyzeMessage } from './detector.js';
import { punishUser, notifyAdminLog } from './moderation.js';
import { handleAdminCommands } from './admin.js';

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
    const isMaliciousSource = BLACKLISTED_FORWARD_SOURCES.has(forwardSrc);

    if (isMaliciousSource && userId) {
      log('info', 'Forward 黑名單來源攔截', { chatId, userId, forwardSrc });
      await deleteMessage(botToken, chatId, message.message_id);
      
      const count = 3;
      const reason = 'banned_source';
      const actionType = await punishUser(botToken, env, chatId, message.from, reason, count);
      
      ctx.waitUntil(Promise.all([
        notifyAdminLog(botToken, env, { chatId, userId, username: message.from?.username, foundUrls: [`[forwardSrc: ${forwardSrc}]`], reason, originalText, count })
      ]));
      sendTemporaryMessage(botToken, chatId, t('kick_final'), ctx);
      return;
    }

    // 普通轉發放行，交由 Rule 2/3 進行關鍵詞與連結檢查
    log('info', 'Forward allowed (passing to content scanning)', { chatId, userId, forwardSrc });
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
