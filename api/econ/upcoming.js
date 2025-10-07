// api/econ/upcoming.js
'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    // Public endpoint (no auth) so VF and the bot can call it directly
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Number(q.get('limit') || 5));

    // 1) Try the short cache first
    let items = [];
    try {
      const raw = await kv.get('econ:cache:upcoming');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed?.items)) items = parsed.items;
      }
    } catch {}

    // 2) Safe fallback (index-based read + time filtering)
    if (!items.length) {
      const now = Date.now();
      const end = now + 24 * 60 * 60 * 1000; // next 24h

      const raw = await kv.zrange('econ:manual', 0, -1); // strings
      const all = (raw || [])
        .map(s => {
          try {
            const o = JSON.parse(s);
            o.ts = Date.parse(o.date); // ms
            return o;
          } catch { return null; }
        })
        .filter(Boolean);

      items = all
        .filter(e => Number.isFinite(e.ts) && e.ts >= now && e.ts <= end)
        .sort((a, b) => a.ts - b.ts)
        .slice(0, limit);
    }

    // 3) Bilingual formatting
    const countryAr = {
      'United States': 'الولايات المتحدة',
      'Euro Area': 'منطقة اليورو',
      'United Kingdom': 'المملكة المتحدة',
      'Japan': 'اليابان',
      'China': 'الصين'
    };

    const fmt = (ms) =>
      new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }).format(new Date(ms));

    const lines = items.map((ev, i) => {
      const ar = countryAr[ev.country] || ev.country;
      const extra =
        (ev.forecast ? ` | توقع/Forecast ${ev.forecast}` : '') +
        (ev.previous ? ` | سابق/Previous ${ev.previous}` : '');
      return `${i + 1}. *${ev.country} / ${ar}*: ${ev.event}\n   ${fmt(ev.ts)}${extra}`;
    });

    const text = items.length
      ? `📅 *الأحداث الاقتصادية القادمة / Upcoming*\n\n${lines.join('\n\n')}`
      : `لا توجد أحداث قادمة خلال 24 ساعة.\nNo upcoming events in the next 24h.`;

    return res.json({ ok: true, count: items.length, items, text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
