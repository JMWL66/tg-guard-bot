# 🛡️ TG Guard Bot — Cloudflare Workers 群組守衛機器人

一個基於 **Cloudflare Workers** 邊緣計算的高效能 Telegram 群組管理機器人。採用模組化架構，具備精準的廣告過濾、階梯式處罰、新人保護等功能，能有效維持群組環境純淨。

---

## 🔥 核心功能 (Core Features)

### 1. 🚫 分級處罰體系（廣告 vs 一般違規）

機器人根據違規**嚴重程度**分級處理，而非統一對待：

| 違規行為 | 嚴重程度 | 處置方式 |
| :--- | :--- | :--- |
| 進群 5 分鐘內發送任何連結 | 🔴 極高（廣告機器人特徵） | **直接永久封禁**，跳過計數器 |
| 轉發黑名單廣告源（模糊匹配） | 🔴 極高 | **直接永久封禁** |
| 第 1 次發送廣告連結/關鍵詞 | 🟠 高 | 禁媒體 **24 小時**（可發純文字） |
| 第 2 次廣告違規 | 🟠 高 | **完全禁言 7 天** |
| 第 3 次或以上廣告違規 | 🔴 極高 | **永久封禁** |
| 連續發送無意義短訊息 | 🟡 中（輕度騷擾） | **靜音 1 小時**，不記入廣告計數器 |
| 洗版/重複訊息 | 🟠 高（惡意刷屏） | 走廣告計數器，逐級升級處罰 |

### 2. 🛡️ 新人 5 分鐘保護期（真實生效）

- 新成員加入群組時，機器人即時記錄入群時間戳至 KV 存儲。
- **5 分鐘保護期內**：發送任何連結（包含普通外部網站）→ **直接永久封禁**，不給第二次機會。
- 保護期結束後：老群友可正常發送普通連結，僅拦截邀請連結與黑名單域名。

### 3. 🔍 深度掃描引擎

- **關鍵詞組合檢測**：採用 AND 組合邏輯（多個詞同時出現才觸發），大幅降低誤報率。
- **文字正規化**：自動去除空格、標點符號，應對「币 圈 免 费」等變體規避手段。
- **Regex + Entities 雙重掃描**：同時覆蓋一般訊息、編輯後的訊息、媒體說明（Caption）及轉發來源標題。
- **轉發黑名單（模糊匹配）**：黑名單中的詞只要出現在轉發來源頻道名稱中即可觸發，無需完全匹配，有效防範廣告頻道改名規避。
- **Emoji 特徵偵測**：訊息含 4 個或以上 ✅ 自動觸發廣告規則。

### 4. ⚡ 效能優化

- **管理員權限快取**：自動快取管理員身份 1 小時，大幅減少 API 調用。
- **隱形指令**：管理員指令執行後，指令本身與 Bot 回覆均會自動刪除，保持群組版面整潔。
- **非同步日誌**：違規記錄非同步寫入 KV，不阻塞主流程。

---

## 🧩 模組化架構 (Module Structure)

```text
src/
├── config.js      # 核心配置、黑白名單、關鍵詞組合庫
├── i18n.js        # 多語言（中文/英文）翻譯模組
├── utils.js       # 基礎工具函數、Telegram API 底層調用
├── store.js       # Cloudflare KV 存取（違規計數、白名單、新人記錄）
├── detector.js    # 違規檢測引擎（關鍵詞、連結分析）
├── moderation.js  # 處罰執行與管理員日誌通知
├── report.js      # CSV 報表生成與發送
├── admin.js       # 管理員指令路由處理
├── message.js     # 主幹消息處理流程
└── index.js       # Cloudflare Worker 入口
```

---

## 🛠️ 管理員指令 (Admin Commands)

僅限**建立者**或**管理員**使用。在群組中執行後，指令與回覆均會自動刪除。

| 指令 | 功能說明 | 範例 |
| :--- | :--- | :--- |
| `/help` | 顯示所有可用管理指令 | `/help` |
| `/allow <domain>` | 新增域名到動態白名單 | `/allow google.com` |
| `/disallow <domain>` | 從動態白名單移除域名 | `/disallow google.com` |
| `/allowuser <uid>` | 將用戶 UID 加入特許白名單（完全豁免所有規則） | `/allowuser 123456` |
| `/disallowuser <uid>` | 從特許白名單移除用戶 | `/disallowuser 123456` |
| `/listwhitelist` | 查看當前所有白名單規則 | `/listwhitelist` |
| `/unban <uid>` | 手動解封被封禁的成員 | `/unban 1234567` |
| `/resetviolations <uid>` | 清空特定成員的廣告違規計數 | `/resetviolations 1234567` |
| `/resetadmincache <uid>` | 重置指定 UID 的管理員權限快取 | `/resetadmincache` |
| `/exportall` | 立即在私訊中接收完整的歷史違規 CSV 報表 | `/exportall` |
| `/getexporturl` | 獲取網頁版報表下載連結（需設定 `EXPORT_SECRET`） | `/getexporturl` |

---

## 🚀 部署指南 (Deployment)

### 前置條件

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare](https://cloudflare.com/) 帳號（免費方案即可）
- 已建立的 Telegram Bot（透過 [@BotFather](https://t.me/BotFather) 創建）

### 1. 安裝依賴

```bash
git clone https://github.com/JMWL66/tg-guard-bot.git
cd tg-guard-bot
npm install
```

### 2. 登入 Cloudflare

```bash
npx wrangler login
```

### 3. 建立 KV 命名空間

```bash
npx wrangler kv namespace create TG_GUARD_KV
```

將輸出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "TG_GUARD_KV"
id = "你的 KV namespace ID"
```

### 4. 設定 Secrets

```bash
npx wrangler secret put BOT_TOKEN            # Telegram Bot API Token
npx wrangler secret put ADMIN_ID             # 你的個人 UID（接收違規日誌）
npx wrangler secret put EXPORT_SECRET        # （選填）報表下載密鑰
npx wrangler secret put WEBHOOK_SECRET_TOKEN # （選填）Webhook 安全令牌
```

### 5. 部署

```bash
npx wrangler deploy
```

### 6. 設定 Webhook

將 Telegram Webhook 指向你的 Worker：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev"
```

### 7. 拉入群組並設為管理員

將 Bot 加入目標群組，並賦予以下權限：
- ✅ 刪除訊息
- ✅ 封禁成員

---

## 🧪 測試清單 (QA Checklist)

- [ ] 私訊機器人發送 `/help`，確認收到指令說明
- [ ] 新用戶入群後 5 分鐘內發送外部連結，確認被永久封禁
- [ ] 新用戶入群 5 分鐘後發送正常連結，確認正常放行
- [ ] 發送帶有 5 個 ✅ 的訊息，確認被觸發廣告規則
- [ ] 連續發送 3 條只含 1 個字的訊息，確認被靜音 1 小時（不影響廣告計數）
- [ ] 測試 `/allow google.com` 後非管理員是否能正常發送 google.com 連結
- [ ] 管理員在群組發送 `/help`，確認指令消失且 Bot 回覆 5 秒後消失
- [ ] 管理員執行 `/exportall`，確認在私訊中收到 CSV 報表

---

## 🧩 常見問題 (FAQ)

### Q1: 如何找到我的數字 UID？
私訊 Telegram 的 [@userinfobot](https://t.me/userinfobot)，它會回傳你的 `Id`（例如 `5788378651`）。

### Q2: 為什麼設定了 ADMIN_ID 卻收不到違規通知？
Telegram 的機制要求你必須先**主動與 Bot 開啟對話**（點擊 Start）。之後有人違規時，Bot 才有權限發送私訊通知給你。

### Q3: 指令發出後沒有任何反應？
1. 確認 Bot 已被設為群組管理員，且擁有「刪除訊息」與「封禁成員」兩項權限。
2. 確認私訊 `/help` 能否正常回覆（用於判斷 Bot 是否在線）。

### Q4: 普通用戶無意中被誤封了怎麼辦？
管理員使用 `/unban <uid>` 解封，並使用 `/resetviolations <uid>` 清空他的違規記錄，即可讓他重新加入。

---

## 💻 維護指令參考

```bash
# 部署最新程式碼到 Cloudflare
npx wrangler deploy

# 查看即時運行日誌（調試用）
npx wrangler tail tg-guard-bot-v2

# 更新 Bot Token
npx wrangler secret put BOT_TOKEN
```

---

## 🔐 安全建議

> **強烈建議將此 GitHub 倉庫設為 Private（私密）**，防範廣告商研究你的過濾邏輯並針對性規避。

---

*Powered by Cloudflare Workers · Maintained by [JMWL66](https://github.com/JMWL66)*
