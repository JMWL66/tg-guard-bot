import { callTelegramAPI, escapeHtml, log } from './utils.js';
import { CONFIG } from './config.js';

// ─── 階梯式處罰（1: 24h禁媒體/連結, 2: 7d全禁, 3: 永久封鎖）──────
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

  // 紀錄歷史（加 TTL 防止 KV 無限膨脹）
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Deleted Account';
  await env.TG_GUARD_KV.put(`ban_hist:${chatId}:${user.id}`, `${reason} (${actionType})`, {
    expirationTtl: CONFIG.BAN_HIST_TTL,
    metadata: { name, username: user.username || '', date: new Date().toISOString() }
  });

  return actionType;
}

// ─── 管理員日誌通知（HTML 格式，防止原文中的 * _ ` 破壞排版）──────
export async function notifyAdminLog(botToken, env, {
  chatId, userId, username, foundUrls, reason, originalText, count, fileUniqueId
}) {
  const adminId = env.ADMIN_ID;
  if (!adminId) return;

  // ─── 存儲紀錄 ───
  // 摘要同時寫入 KV metadata，讓報表匯出可直接從 list() 讀取、免逐條 get（避開子請求上限）
  // value 仍保留完整原文供需要時細查；TTL 防止無限膨脹
  try {
    const now = new Date();
    const logKey = `vlog:${now.getTime()}:${userId}`;
    const logData = {
      date: now.toISOString().split('T')[0],
      timestamp: now.toISOString(),
      userId, username: username || 'N/A',
      reason, originalText: originalText || '', count
    };
    const meta = {
      date: logData.date, timestamp: logData.timestamp,
      userId: String(userId ?? ''), username: logData.username,
      reason, count,
      text: (originalText || '').slice(0, 120) // metadata 上限 1024B，原文截斷
    };
    await env.TG_GUARD_KV.put(logKey, JSON.stringify(logData), {
      expirationTtl: CONFIG.VLOG_TTL,
      metadata: meta
    });
  } catch (e) {
    log('error', '儲存違規紀錄失敗', { error: e.message });
  }

  // ─── 發送通知（HTML）───
  const reasonMap = {
    forward: '轉發訊息',
    banned_source: '黑名單轉發源',
    link: '發送連結',
    ext_link: '非白名單外鏈（僅刪除）',
    link_newuser: '新人發連結（時間窗）',
    link_firstmsg: '新人發連結（前N條）',
    keyword: '關鍵詞黑名單',
    spam: '洗版/重複',
    short: '無意義短訊息',
    noise: '無意義噪音訊息（純數字/字母）',
    cas: 'CAS 聯邦封禁',
    sender_chat: '頻道身份發言',
    image_bl: '圖片黑名單'
  };

  const preview = originalText
    ? `\n📝 原文: <code>${escapeHtml(originalText.slice(0, 120))}${originalText.length > 120 ? '…' : ''}</code>`
    : '';

  const imgLine = fileUniqueId
    ? `\n🖼 圖片ID: <code>${escapeHtml(fileUniqueId)}</code>\n   ↳ 拉黑: <code>/bladd image ${escapeHtml(fileUniqueId)}</code>`
    : '';

  const urlLine = foundUrls?.length
    ? `\n🔗 內容: <code>${escapeHtml(foundUrls.join(', ').slice(0, 200))}</code>`
    : '';

  const txt = `🚨 <b>違規活動記錄</b>\n\n` +
    `📍 群組: <code>${chatId}</code>\n` +
    `👤 用戶: <code>${userId}</code> (${escapeHtml(username || '無名氏')})\n` +
    `⚡ 原因: ${escapeHtml(reasonMap[reason] || reason)}` +
    preview +
    urlLine +
    imgLine +
    `\n⚠️ 累計次數: ${count}`;

  await callTelegramAPI(botToken, 'sendMessage', {
    chat_id: adminId, text: txt, parse_mode: 'HTML'
  });
}
