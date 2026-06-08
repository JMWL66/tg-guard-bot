export async function generateViolationCSV(env) {
  let allLogs = [];
  
  // ─── 1. 獲取新版詳細紀錄 (vlog:) ───
  // 優先讀 list() 回傳的 metadata（零額外 get）；舊紀錄無 metadata 時才回退讀 value
  let cursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'vlog:', cursor });
    for (const key of list.keys) {
      const m = key.metadata;
      if (m && m.userId) {
        allLogs.push({
          date: m.date, timestamp: m.timestamp, userId: m.userId,
          username: m.username, reason: m.reason,
          originalText: m.text || '', count: m.count
        });
      } else {
        const val = await env.TG_GUARD_KV.get(key.name);
        if (val) { try { allLogs.push(JSON.parse(val)); } catch (e) {} }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // ─── 2. 獲取舊版紀錄 (ban_hist:) 並合併 ───
  // 預先建立已見 userId 集合，避免在迴圈內做 O(n²) 掃描
  const seenUserIds = new Set(allLogs.map(l => String(l.userId)));
  let banCursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'ban_hist:', cursor: banCursor });
    for (const key of list.keys) {
      const parts = key.name.split(':');
      const userId = parts.pop();
      const chatId = parts.pop();

      // 避免重複（如果已經在 vlog 中有了）
      if (seenUserIds.has(String(userId))) continue;
      seenUserIds.add(String(userId));

      const reason = await env.TG_GUARD_KV.get(key.name);
      const m = key.metadata || {};
      const count = await env.TG_GUARD_KV.get(`violations:${chatId}:${userId}`) || '1';

      allLogs.push({
        date: m.date ? m.date.split('T')[0] : '歷史',
        timestamp: m.date || '1970-01-01T00:00:00Z',
        userId: userId,
        username: m.username ? `${m.name} (@${m.username})` : m.name || 'N/A',
        reason: reason || 'Unknown',
        originalText: '(舊版歷史，無原文預覽)',
        count: count
      });
    }
    banCursor = list.list_complete ? undefined : list.cursor;
  } while (banCursor);

  // ─── 3. 排序並生成 CSV 內容 ───
  allLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const header = '\uFEFF日期,用戶號,用戶名,原因,原文內容,累計次數\n';
  const rows = allLogs.map(log => {
    return [log.date, log.userId, log.username, log.reason, log.originalText, log.count]
      .map(csvCell).join(',');
  }).join('\n');

  return header + rows;
}

// CSV 單元格轉義 + 公式注入防護：以 = + - @ 開頭的值前置 ' 防止 Excel 當公式執行
function csvCell(value) {
  let s = String(value ?? '').replace(/[\r\n]/g, ' ');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function sendCSVDoc(botToken, adminId, csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('chat_id', adminId);
  formData.append('document', blob, filename);

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const response = await fetch(url, { method: 'POST', body: formData });
  return await response.json();
}
