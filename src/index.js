/**
 * tg-guard-bot — Cloudflare Workers Telegram 群組守衛機器人 (終極究極版)
 *
 * 功能核心：
 *  1. 🛡️ 新成員引導：入群歡迎與保護期提示
 *  2. ⚡ 極致效能：條件式讀取 KV，管理員狀態精準快取 (1h)
 *  3. ♻️ 權限同步：支援 /resetadmincache
 *  4. 🧹 隱形執行：指令執行後自動刪除，保持群組版面純淨
 *  5. 🔍 深度掃描：Regex + Telegram Entities 雙重過濾
 *  6. 🚫 零容忍：Forward / 連結 / 洗版 → 立即踢出，無警告
 */

import { CONFIG } from './config.js';
import { t } from './i18n.js';
import { log, sendTemporaryMessage } from './utils.js';
import { generateViolationCSV, sendCSVDoc } from './report.js';
import { handleMessage } from './message.js';

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
    
    // ... 後續邏輯
    if (env.WEBHOOK_SECRET_TOKEN && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const msg = update.message || update.edited_message || update.channel_post;
      if (msg) {
        if (msg.new_chat_members) {
          const chatId = msg.chat.id;
          const cooldownKey = `welcome_cooldown:${chatId}`;
          const isCooling = await env.TG_GUARD_KV.get(cooldownKey);
          if (!isCooling) {
            await env.TG_GUARD_KV.put(cooldownKey, '1', { expirationTtl: CONFIG.WELCOME_COOLDOWN_SEC });
            sendTemporaryMessage(botToken, chatId, t('welcome'), ctx);
          }
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
    const adminId = env.ADMIN_ID;
    if (!botToken || !adminId) return;

    try {
      const csv = await generateViolationCSV(env);
      await sendCSVDoc(botToken, adminId, csv, `daily_all_history_${new Date().toISOString().split('T')[0]}.csv`);
      log('info', '每日全量報表已發送');
    } catch (e) {
      log('error', '每日報表發送失敗', { error: e.message });
    }
  }
};
