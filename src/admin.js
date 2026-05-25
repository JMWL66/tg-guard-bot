import { WHITELISTED_USER_IDS } from './config.js';
import { t } from './i18n.js';
import { callTelegramAPI, deleteMessage, sendTemporaryMessage } from './utils.js';
import { getDynamicWhitelist, getDynamicUserWhitelist, getCustomBlacklist, addToBlacklist, removeFromBlacklist } from './store.js';
import { generateViolationCSV, sendCSVDoc } from './report.js';

const BL_TYPE_LABEL = { link: '邀請連結', user: '用戶名', forward: '轉發源', kw: '關鍵詞組合' };

// 解析 /bladd 或 /blrm 的 value：kw 類型支援逗號分隔 → 陣列
function parseBlValue(type, raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  if (type === 'kw') {
    const parts = trimmed.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  if (type === 'user') return trimmed.replace(/^@/, '').toLowerCase();
  return trimmed;
}

function formatBlEntry(type, item) {
  if (type === 'kw' && Array.isArray(item)) return item.join(' + ');
  return String(item);
}

export async function handleAdminCommands(botToken, env, ctx, message, status) {
  const isAdmin = status === 'creator' || status === 'administrator';
  if (!isAdmin) return false;

  const rawText = message.text || '';
  const chatId = message.chat.id;
  const text = rawText.replace(/\/\w+@\w+/, (m) => m.split('@')[0]);

  const cmdPrefixes = ['/allow ', '/disallow ', '/allowuser ', '/disallowuser ', '/listwhitelist', '/unban ', '/exportbans', '/resetviolations ', '/resetadmincache', '/help', '/exportall', '/getexporturl', '/bladd ', '/blrm ', '/bllist'];
  const matched = cmdPrefixes.some(p => text.startsWith(p) || text === p.trim());
  if (!matched) return false;

  if (message.chat.type !== 'private') {
    ctx.waitUntil(deleteMessage(botToken, chatId, message.message_id));
  }

  const sendMessage = (txt) => {
    if (message.chat.type === 'private') {
      const p = callTelegramAPI(botToken, 'sendMessage', { chat_id: chatId, text: txt, parse_mode: 'Markdown' });
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
      return p;
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
  } else if (text.startsWith('/bladd ')) {
    // /bladd <type> <value...>
    const parts = text.slice('/bladd '.length).trim().split(/\s+/);
    const type = parts.shift();
    const raw = parts.join(' ');
    const value = parseBlValue(type, raw);
    if (!type || !BL_TYPE_LABEL[type] || !value) {
      sendMessage('⚠️ 用法：`/bladd <link|user|forward|kw> <值>`\nkw 多詞用逗號分隔（AND 組合）');
    } else {
      await addToBlacklist(env, type, value);
      sendMessage(`✅ 已加入${BL_TYPE_LABEL[type]}黑名單：\`${formatBlEntry(type, value)}\``);
    }
  } else if (text.startsWith('/blrm ')) {
    const parts = text.slice('/blrm '.length).trim().split(/\s+/);
    const type = parts.shift();
    const raw = parts.join(' ');
    const value = parseBlValue(type, raw);
    if (!type || !BL_TYPE_LABEL[type] || !value) {
      sendMessage('⚠️ 用法：`/blrm <link|user|forward|kw> <值>`');
    } else {
      const next = await removeFromBlacklist(env, type, value);
      sendMessage(`❌ 已移除${BL_TYPE_LABEL[type]}：\`${formatBlEntry(type, value)}\`\n剩餘：${next.length} 條`);
    }
  } else if (text.startsWith('/bllist')) {
    const arg = text.slice('/bllist'.length).trim();
    const types = arg && BL_TYPE_LABEL[arg] ? [arg] : Object.keys(BL_TYPE_LABEL);
    let out = '📋 *自訂黑名單清單：*\n';
    for (const type of types) {
      const list = await getCustomBlacklist(env, type);
      out += `\n*${BL_TYPE_LABEL[type]}* (${list.length})\n`;
      if (list.length === 0) {
        out += '_(空)_\n';
      } else {
        out += list.slice(0, 30).map(it => `• \`${formatBlEntry(type, it)}\``).join('\n') + '\n';
        if (list.length > 30) out += `_… 還有 ${list.length - 30} 條_\n`;
      }
    }
    sendMessage(out);
  } else if (text === '/help') {
    sendMessage(t('help'));
  }
  return true;
}
