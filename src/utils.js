export function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

export async function callTelegramAPI(botToken, method, body, attempt = 0) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) {
    // 429 限流：依 retry_after 退避重試（上限 5s、最多 2 次），避免刷屏時刪除/封禁被靜默丟棄
    if (result.error_code === 429 && attempt < 2) {
      const retryAfter = Math.min(result.parameters?.retry_after ?? 1, 5);
      log('warn', `API 429 限流，${retryAfter}s 後重試: ${method}`, { attempt });
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return callTelegramAPI(botToken, method, body, attempt + 1);
    }
    log('error', `API 失敗: ${method}`, { result, body });
  }
  return result;
}

export async function deleteMessage(botToken, chatId, messageId) {
  return callTelegramAPI(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function sendTemporaryMessage(botToken, chatId, text, ctx, parseMode = 'Markdown') {
  const promise = (async () => {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const result = await callTelegramAPI(botToken, 'sendMessage', body);
    if (result.ok) {
      await new Promise(r => setTimeout(r, 5000));
      await deleteMessage(botToken, chatId, result.result.message_id);
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(promise);
}

export function normalizeText(text) {
  if (!text) return '';
  // 移除所有空格、標點符號、換行符，統一口語化字符以便比對
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return Math.abs(h).toString(16);
}
