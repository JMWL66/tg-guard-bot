/**
 * tg-guard-bot — Cloudflare Workers Telegram 群組守衛機器人
 *
 * 防禦層級：
 *  0. 入群 CAPTCHA：60s 內未點按鈕自動踢出
 *  1. CAS 聯邦封禁庫：命中即永封
 *  2. sender_chat 外部頻道身份發言：直接封禁
 *  3. 黑名單轉發來源 / 邀請連結 / 用戶名 / 關鍵詞組合
 *  4. 洗版 / 重複 / 短訊息計數器
 *  5. 階梯式處罰：24h 靜音 → 7d 靜音 → 永封
 */

import { log, callTelegramAPI } from './utils.js';
import { generateViolationCSV, generateDailyTextReport } from './report.js';
import { handleMessage } from './message.js';
import { recordUserJoinTime } from './store.js';
import { startCaptcha, handleCaptchaCallback, sweepExpiredCaptchas, markVerified } from './captcha.js';
import { checkCAS } from './cas.js';
import { SYSTEM_BOT_IDS, WHITELISTED_USER_IDS } from './config.js';
import { markHighRisk } from './store.js';

async function isInviterAdmin(botToken, env, chatId, inviterId) {
  if (!inviterId) return false;
  if (SYSTEM_BOT_IDS.has(inviterId)) return true;
  const cacheKey = `admin_cache:${chatId}:${inviterId}`;
  const cached = await env.TG_GUARD_KV.get(cacheKey);
  if (cached === 'creator' || cached === 'administrator') return true;
  const result = await callTelegramAPI(botToken, 'getChatMember', { chat_id: chatId, user_id: inviterId });
  if (result.ok && (result.result.status === 'creator' || result.result.status === 'administrator')) {
    await env.TG_GUARD_KV.put(cacheKey, result.result.status, { expirationTtl: 3600 });
    return true;
  }
  return false;
}

async function handleNewMembers(botToken, env, ctx, msg) {
  const chatId = msg.chat.id;
  const inviterId = msg.from?.id;
  const inviterIsAdmin = await isInviterAdmin(botToken, env, chatId, inviterId);

  for (const member of msg.new_chat_members) {
    if (!member?.id) continue;

    // bot 加入：跳過 captcha，不做 CAS（CAS 只查 user）
    if (member.is_bot) {
      ctx.waitUntil(recordUserJoinTime(env, chatId, member.id));
      continue;
    }

    ctx.waitUntil(recordUserJoinTime(env, chatId, member.id));

    // CAS：命中直接 ban，無需 captcha
    const cas = await checkCAS(env, member.id);
    if (cas.banned) {
      log('info', 'CAS 入群攔截', { chatId, userId: member.id, offenses: cas.offenses });
      await callTelegramAPI(botToken, 'banChatMember', { chat_id: chatId, user_id: member.id });
      continue;
    }

    // 管理員手動拉入 / 白名單用戶：跳過 captcha 並標記已驗證
    if (inviterIsAdmin && inviterId !== member.id) {
      ctx.waitUntil(markVerified(env, chatId, member.id));
      continue;
    }
    if (WHITELISTED_USER_IDS.has(member.id)) {
      ctx.waitUntil(markVerified(env, chatId, member.id));
      continue;
    }

    // 發 captcha
    await startCaptcha(botToken, env, chatId, member);

    // 異步評估帳號風險（不阻塞主流程）：無頭像 → 高風險 → 30min 冷卻期
    ctx.waitUntil((async () => {
      try {
        const photos = await callTelegramAPI(botToken, 'getUserProfilePhotos', {
          user_id: member.id, limit: 1
        });
        if (photos.ok && photos.result.total_count === 0) {
          await markHighRisk(env, chatId, member.id);
          log('info', '高風險帳號（無頭像）→ 冷卻期延長', { chatId, userId: member.id });
        }
      } catch { /* 查詢失敗不影響主流程 */ }
    })());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── 網頁匯出處理 ───
    if (url.pathname === '/export') {
      const token = url.searchParams.get('token');
      if (!env.EXPORT_SECRET || token !== env.EXPORT_SECRET) {
        return new Response('Unauthorized', { status: 403 });
      }
      const csv = await generateViolationCSV(env);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="all_violations_${new Date().toISOString().split('T')[0]}.csv"`
        }
      });
    }

    if (request.method !== 'POST') return new Response('OK', { status: 200 });
    const botToken = env.BOT_TOKEN;
    if (!botToken) return new Response('Miss BOT_TOKEN', { status: 500 });

    if (env.WEBHOOK_SECRET_TOKEN && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();

      // ─── Callback Query：處理 captcha 按鈕點擊 ───
      if (update.callback_query) {
        await handleCaptchaCallback(botToken, env, update.callback_query);
        return new Response('OK', { status: 200 });
      }

      const msg = update.message || update.edited_message || update.channel_post;
      if (msg) {
        if (msg.new_chat_members) {
          await handleNewMembers(botToken, env, ctx, msg);
        }
        if (!msg.new_chat_members && !msg.left_chat_member && !msg.pinned_message) {
          await handleMessage(botToken, env, ctx, msg);
        }
      }
    } catch (e) { log('error', 'Runtime Error', { error: e.message }); }
    return new Response('OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const botToken = env.BOT_TOKEN;
    if (!botToken) return;

    // 每分鐘：掃描超時 captcha
    if (event.cron === '* * * * *') {
      try {
        const kicked = await sweepExpiredCaptchas(botToken, env);
        if (kicked > 0) log('info', 'Captcha sweep done', { kicked });
      } catch (e) {
        log('error', 'Captcha sweep failed', { error: e.message });
      }
    }

    // 每日 00:00 UTC：若前一天有違規則推送文字摘要，沒有則不推送
    if (event.cron === '0 0 * * *') {
      const adminId = env.ADMIN_ID;
      if (!adminId) return;
      try {
        const dateStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0];
        const text = await generateDailyTextReport(env, dateStr);
        if (text) {
          await callTelegramAPI(botToken, 'sendMessage', { chat_id: adminId, text, parse_mode: 'HTML' });
          log('info', '每日文字報表已發送', { dateStr });
        }
      } catch (e) {
        log('error', '每日報表發送失敗', { error: e.message });
      }
    }
  }
};
