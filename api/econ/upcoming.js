// api/econ/upcoming.js
'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    const okAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    // allow public read if you prefer; keep auth if you want
    if (!okAuth) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const q = new URL(req.url, 'http://x').searchParams;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 5;

    let cache = null;
    try {
      const raw = await kv.get('econ:cache:upcoming');
      cache = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch {}

    let items = Array.isArray(cache?.items) ? cache.items : [];

    // fallback: read the next 24h if cache is empty
    if (!items.length) {
      const now = Date.now();
      const end = now + 24 * 60 * 60 * 1000;
      const raw = await kv.zrange('econ:manual', now, end, { byScore: true });
      items = (raw || []).map(s => {
        try { const o = JSON.parse(s); o.ts = Date.parse(o.date); return o; }
        catch { return null; }
      }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
    }

    items = items.slice(0, limit);

    const lines = items.map((ev, i) => {
      const when = new Date(ev.ts);
      const timeStr = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
      }).format(when);
      const fr = ev.forecast ? ` | توقع/Forecast ${ev.forecast}` : '';
      return `${i+1}. *${ev.country}*: ${ev.event}\n   ${timeStr}${fr}`;
    });

    const text =
      items.length
        ? `📅 *الأحداث الاقتصادية القادمة / Upcoming*\n\n${lines.join('\n\n')}`
        : `لا توجد أحداث قادمة خلال الفترة المحددة.\nNo upcoming events in the selected window.`;

    return res.json({ ok: true, count: items.length, items, text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
