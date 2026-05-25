import { CONFIG } from './config.js';
import { callTelegramAPI, deleteMessage, log } from './utils.js';

// 入群驗證 KV TTL：10 分鐘（cron 每分鐘清理，這個是兜底）
const CAPTCHA_KV_TTL = 600;

// 已驗證用戶緩存：72h 內重新加入無需再驗證
const VERIFIED_TTL = 72 * 3600;

function fullPermissions() {
  return {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false
  };
}

export async function isAlreadyVerified(env, chatId, userId) {
  const v = await env.TG_GUARD_KV.get(`verified:${chatId}:${userId}`);
  return !!v;
}

export async function markVerified(env, chatId, userId) {
  await env.TG_GUARD_KV.put(`verified:${chatId}:${userId}`, '1', { expirationTtl: VERIFIED_TTL });
}

export async function startCaptcha(botToken, env, chatId, user) {
  const userId = user.id;
  if (!userId || user.is_bot) return;

  // 已驗證過：直接跳過（防止短時間退群再進的騷擾）
  if (await isAlreadyVerified(env, chatId, userId)) return;

  // 先禁言
  await callTelegramAPI(botToken, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false
    }
  });

  // 發按鈕
  const displayName = user.first_name || user.username || `User${userId}`;
  const safeName = displayName.replace(/[<>&]/g, '');
  const text = `👋 欢迎 <b>${safeName}</b>！\n\n请在 <b>${CONFIG.CAPTCHA_TIMEOUT}</b> 秒内点击下方按钮证明你不是机器人，否则将被自动移出群组。`;
  const result = await callTelegramAPI(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✋ 我不是机器人', callback_data: `cap:${userId}` }
      ]]
    }
  });

  if (result.ok) {
    const now = Math.floor(Date.now() / 1000);
    await env.TG_GUARD_KV.put(
      `captcha:${chatId}:${userId}`,
      JSON.stringify({ msgId: result.result.message_id, t: now }),
      { expirationTtl: CAPTCHA_KV_TTL }
    );
  } else {
    log('error', 'Captcha send failed', { chatId, userId, result });
  }
}

export async function handleCaptchaCallback(botToken, env, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('cap:')) return false;

  const expectedUserId = parseInt(data.slice(4));
  const clickerId = callbackQuery.from?.id;
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId || !expectedUserId) {
    await callTelegramAPI(botToken, 'answerCallbackQuery', { callback_query_id: callbackQuery.id });
    return true;
  }

  if (clickerId !== expectedUserId) {
    await callTelegramAPI(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '⚠️ 这不是给你的验证按钮',
      show_alert: true
    });
    return true;
  }

  const key = `captcha:${chatId}:${expectedUserId}`;
  const stored = await env.TG_GUARD_KV.get(key);

  await callTelegramAPI(botToken, 'restrictChatMember', {
    chat_id: chatId,
    user_id: expectedUserId,
    permissions: fullPermissions()
  });

  if (stored) {
    try {
      const { msgId } = JSON.parse(stored);
      if (msgId) await deleteMessage(botToken, chatId, msgId);
    } catch { /* noop */ }
    await env.TG_GUARD_KV.delete(key);
  }
  await markVerified(env, chatId, expectedUserId);

  await callTelegramAPI(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: '✅ 验证通过，欢迎入群！'
  });
  return true;
}

// 由 cron 每分鐘呼叫，掃描超時未驗證的入群者並踢出
export async function sweepExpiredCaptchas(botToken, env) {
  const now = Math.floor(Date.now() / 1000);
  let cursor;
  let kicked = 0;
  do {
    const list = await env.TG_GUARD_KV.list(cursor ? { prefix: 'captcha:', cursor } : { prefix: 'captcha:' });
    for (const k of list.keys) {
      const raw = await env.TG_GUARD_KV.get(k.name);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!parsed?.t || now - parsed.t < CONFIG.CAPTCHA_TIMEOUT) continue;

      const parts = k.name.split(':');
      const chatId = parts[1];
      const userId = parseInt(parts[2]);
      log('info', 'Captcha expired → kick', { chatId, userId });

      // ban + unban = kick（允許用戶再次申請加入）
      await callTelegramAPI(botToken, 'banChatMember', { chat_id: chatId, user_id: userId });
      await callTelegramAPI(botToken, 'unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });
      if (parsed.msgId) await deleteMessage(botToken, chatId, parsed.msgId);
      await env.TG_GUARD_KV.delete(k.name);
      kicked++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return kicked;
}
