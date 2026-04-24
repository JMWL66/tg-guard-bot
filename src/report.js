export async function generateViolationCSV(env) {
  let allLogs = [];
  
  // ─── 1. 獲取新版詳細紀錄 (vlog:) ───
  let cursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'vlog:', cursor });
    for (const key of list.keys) {
      const val = await env.TG_GUARD_KV.get(key.name);
      if (val) {
        try { allLogs.push(JSON.parse(val)); } catch (e) {}
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // ─── 2. 獲取舊版紀錄 (ban_hist:) 並合併 ───
  let banCursor;
  do {
    const list = await env.TG_GUARD_KV.list({ prefix: 'ban_hist:', cursor: banCursor });
    for (const key of list.keys) {
      const parts = key.name.split(':');
      const userId = parts.pop();
      const chatId = parts.pop();
      
      // 避免重複（如果已經在 vlog 中有了）
      if (allLogs.some(l => String(l.userId) === String(userId))) continue;

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
    const date = log.date || '';
    const uid = log.userId || '';
    const uname = (log.username || '').replace(/"/g, '""');
    const reason = log.reason || '';
    const content = (log.originalText || '').replace(/"/g, '""').replace(/\n/g, ' ');
    const count = log.count || '';
    return `"${date}","${uid}","${uname}","${reason}","${content}","${count}"`;
  }).join('\n');

  return header + rows;
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
