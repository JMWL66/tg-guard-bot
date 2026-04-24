import { callTelegramAPI, log } from './utils.js';

// ─── 階梯式處罰（1: 24h禁媒體/連結, 2: 7d全禁, 3: 永久封鎖）───────
export async function punishUser(botToken, env, chatId, user, reason, count) {
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

// ─── 管理員日誌通知 ─────────────────────────────────────────────
export async function notifyAdminLog(botToken, env, { chatId, userId, username, foundUrls, reason, originalText, count }) {
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
  const txt = `🚨 **違規活動记录**\n\n` +
    `📍 群組: \`${chatId}\`\n` +
    `👤 用戶: \`${userId}\` (${username || '無名氏'})\n` +
    `⚡ 原因: ${reasonMap[reason] || reason}` +
    preview +
    `\n🔗 內容: \`${foundUrls.join(', ')}\`` +
    `\n⚠️ 累計次數: ${count}`;
  await callTelegramAPI(botToken, 'sendMessage', { chat_id: adminId, text: txt, parse_mode: 'Markdown' });
}
