export function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

export async function callTelegramAPI(botToken, method, body) {
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

export async function deleteMessage(botToken, chatId, messageId) {
  return callTelegramAPI(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function sendTemporaryMessage(botToken, chatId, text, ctx) {
  const promise = (async () => {
    const result = await callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
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

export function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return Math.abs(h).toString(16);
}
