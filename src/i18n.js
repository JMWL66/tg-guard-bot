import { CONFIG } from './config.js';

const I18N = {
  zh: {
    allow: "✅ 已准許域名: *{domain}*",
    disallow: "❌ 已移除域名: *{domain}*",
    allow_user: "✅ 已准許用戶 UID: *{userId}*",
    disallow_user: "❌ 已移除准許用戶 UID: *{userId}*",
    list_header: "📋 **目前白名單規則：**\n",
    list_dyn: "\n🌐 **(動態新增域名):**\n",
    list_users: "\n👤 **(特許用戶):**\n",
    reset_admin: "♻️ 已重置 UID 為 {userId} 的管理快取",
    reset_violations: "♻️ 已清空 UID 為 {userId} 的所有違規紀錄",
    unban: "✅ 已解封 UID: *{userId}*，該用戶可重新加入群組。",
    unban_fail: "⚠️ 解封失敗，請確認 UID 是否正確。",
    export_bans: "📋 **封禁名單：**\n已生成封禁人員名單如下：",
    no_bans: "📭 目前尚無封禁记录。",
    help: "📕 **管理員指令：**\n\n" +
      "*白名單*\n" +
      "`/allow <domain>` · `/disallow <domain>`\n" +
      "`/allowuser <uid>` · `/disallowuser <uid>`\n" +
      "`/listwhitelist`\n\n" +
      "*黑名單（動態增刪，無需改代碼）*\n" +
      "`/bladd link <url>` 加入邀請連結\n" +
      "`/bladd user <username>` 加入用戶名（無需 @）\n" +
      "`/bladd forward <name>` 加入轉發源名稱\n" +
      "`/bladd kw 詞1,詞2,...` 加入關鍵詞 AND 組合\n" +
      "`/bladd image <file_unique_id>` 拉黑垃圾圖片（ID 從日誌複製）\n" +
      "`/blrm <type> <值>` 移除\n" +
      "`/bllist [type]` 查看（type 可選: link|user|forward|kw|image）\n\n" +
      "*封禁管理*\n" +
      "`/unban <uid>` · `/exportbans` · `/exportall`\n" +
      "`/resetviolations <uid>` · `/resetadmincache <uid>`\n" +
      "`/help`",
    warn_mute_24h: "⚠️ **首次違規警告**\n該用戶已被禁言 **24 小時**。期間仍可發送純文字訊息，但禁止發送連結、轉發與媒體內容。",
    warn_mute_7d: "⚠️ **二次違規警告**\n該用戶已被**完全禁言 7 天**，期間禁止在本群發送任何訊息。",
    kick_final: "🚫 **多次違規處分**\n該用戶已累計 3 次或更多違規，已被永久移出群組。"
  },
  en: {
    allow: "✅ Allowed: *{domain}*",
    disallow: "❌ Removed: *{domain}*",
    allow_user: "✅ Whitelisted User UID: *{userId}*",
    disallow_user: "❌ Removed Whitelisted User UID: *{userId}*",
    list_header: "📋 **Current Whitelist Rules:**\n",
    list_hard: "\n🏢 **(Built-in Rules):**\n",
    list_dyn: "\n🌐 **(Dynamic Domains):**\n",
    list_users: "\n👤 **(Whitelisted Users):**\n",
    reset_admin: "♻️ Cache reset for UID {userId}",
    unban: "✅ Unbanned UID: *{userId}*. User can rejoin the group.",
    unban_fail: "⚠️ Unban failed. Please check the UID.",
    export_bans: "📋 **Banned List:**\nExported list of banned members:",
    no_bans: "📭 No ban records found.",
    help: "📕 **Admin Commands:**\n" +
      "`/allow <domain>` - Whitelist a domain\n" +
      "`/disallow <domain>` - Remove domain from whitelist\n" +
      "`/allowuser <uid>` - Whitelist a user\n" +
      "`/disallowuser <uid>` - Remove user from whitelist\n" +
      "`/listwhitelist` - See all rules\n" +
      "`/unban <uid>` - Unban a banned member\n" +
      "`/exportbans` - Export banned users list\n" +
      "`/resetadmincache <uid>` - Reset admin cache\n" +
      "`/help` - Show this help"
  }
};

export function t(key, data = {}) {
  let str = I18N[CONFIG.LANG][key] || key;
  for (const [k, v] of Object.entries(data)) str = str.replace(`{${k}}`, v);
  return str;
}
