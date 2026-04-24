import { CONFIG } from './config.js';

const I18N = {
  zh: {
    welcome: "👋 歡迎新成員！此群組開啟保護模式，*前 5 分鐘禁止發送連結*。",
    forward_kick: "🚫 *禁止轉發訊息*\n此群組不允許轉發外部訊息，已將該成員移出。",
    link_kick: "🚫 *禁止發送連結*\n已將發送連結的成員移出群組。",
    spam_kick: "🚫 *洗版/重複訊息偵測*\n已將發送大量重複訊息的成員移出群組。",
    short_kick: "🚫 *無意義訊息*\n連續發送無意義短訊息，已將該成員移出群組。",
    keyword_kick: "🚫 *疑似招攬廣告*\n訊息含有違禁關鍵詞，已將該成員移出群組。",
    allow: "✅ 已准許域名: *{domain}*",
    disallow: "❌ 已移除域名: *{domain}*",
    allow_user: "✅ 已准許用戶 UID: *{userId}*",
    disallow_user: "❌ 已移除准許用戶 UID: *{userId}*",
    list_header: "📋 **目前白名單規則：**\n",
    list_hard: "\n🏢 **(系統內建規則):**\n",
    list_dyn: "\n🌐 **(動態新增域名):**\n",
    list_users: "\n👤 **(特許用戶):**\n",
    reset_admin: "♻️ 已重置 UID 為 {userId} 的管理快取",
    reset_violations: "♻️ 已清空 UID 為 {userId} 的所有違規紀錄",
    unban: "✅ 已解封 UID: *{userId}*，該用戶可重新加入群組。",
    unban_fail: "⚠️ 解封失敗，請確認 UID 是否正確。",
    export_bans: "📋 **封禁名單：**\n已生成封禁人員名單如下：",
    no_bans: "📭 目前尚無封禁记录。",
    help: "📕 **管理員常用指令：**\n" +
      "`/allow <domain>` - 放行特定域名\n" +
      "`/disallow <domain>` - 撤回放行域名\n" +
      "`/allowuser <uid>` - 放行特定用戶\n" +
      "`/disallowuser <uid>` - 撤回放行用戶\n" +
      "`/listwhitelist` - 查看所有白名單\n" +
      "`/unban <uid>` - 解封被封禁的成員\n" +
      "`/exportbans` - 匯出所有封禁名冊\n" +
      "`/resetviolations <uid>` - 清空違規紀錄\n" +
      "`/resetadmincache <uid>` - 重置管理員快取\n" +
      "`/help` - 顯示此說明",
    warn_mute_24h: "⚠️ **首次違規警告**\n該用戶已被禁言 **24 小時**。期間仍可發送純文字訊息，但禁止發送連結、轉發與媒體內容。",
    warn_mute_7d: "⚠️ **二次違規警告**\n該用戶已被**完全禁言 7 天**，期間禁止在本群發送任何訊息。",
    kick_final: "🚫 **多次違規處分**\n該用戶已累計 3 次或更多違規，已被永久移出群組。"
  },
  en: {
    welcome: "👋 Welcome! Group protected. *No links for first 5 mins*.",
    forward_kick: "🚫 *No Forwarded Messages*\nForwarding is not allowed. Member removed.",
    link_kick: "🚫 *No Links Allowed*\nMember removed for posting links.",
    spam_kick: "🚫 *Spam Detected*\nMember removed for flooding or duplicate messages.",
    short_kick: "🚫 *Meaningless Messages*\nMember removed for repeatedly sending short meaningless messages.",
    keyword_kick: "🚫 *Suspected Spam*\nMessage contains banned keywords. Member removed.",
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
