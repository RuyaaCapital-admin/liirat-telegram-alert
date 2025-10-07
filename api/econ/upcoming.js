// api/econ/upcoming.js
'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    // Public endpoint (no auth) so VF and the bot can call it directly
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Number(q.get('limit') || 5));

    // 1) Try the cache first (populated by /api/cron)
    let items = [];
    try {
      const raw = await kv.get('econ:cache:upcoming');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed?.items)) {
          items = parsed.items;
        }
      }
    } catch (err) {
      console.error('[CACHE ERROR]', err.message);
    }

    // 2) Filter to future events only (cache may contain past events)
    const now = Date.now();
    const futureItems = items.filter(e => {
      const ts = Date.parse(e.date);
      return ts >= now;
    }).slice(0, limit);

    console.log(`[UPCOMING] Requested limit: ${limit}, cached: ${items.length}, future: ${futureItems.length}`);

    // 3) Bilingual formatting
    const countryAr = {
      'United States': 'الولايات المتحدة',
      'Euro Area': 'منطقة اليورو',
      'United Kingdom': 'المملكة المتحدة',
      'Japan': 'اليابان',
      'China': 'الصين',
      'Germany': 'ألمانيا',
      'France': 'فرنسا',
      'Canada': 'كندا',
      'Australia': 'أستراليا',
      'Switzerland': 'سويسرا',
      'India': 'الهند',
      'New Zealand': 'نيوزيلندا'
    };

    const fmt = (dateStr) =>
      new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }).format(new Date(dateStr));

    const lines = futureItems.map((ev, i) => {
      const ar = countryAr[ev.country] || ev.country;
      const extra =
        (ev.forecast ? ` | توقع/Forecast ${ev.forecast}` : '') +
        (ev.previous ? ` | سابق/Previous ${ev.previous}` : '');
      return `${i + 1}. *${ev.country} / ${ar}*: ${ev.event}\n   ${fmt(ev.date)}${extra}`;
    });

    const text = futureItems.length
      ? `📅 *الأحداث الاقتصادية القادمة / Upcoming*\n\n${lines.join('\n\n')}`
      : `لا توجد أحداث قادمة.\nNo upcoming events.`;

    return res.json({ 
      ok: true, 
      count: futureItems.length, 
      items: futureItems, 
      text 
    });
  } catch (e) {
    console.error('[ERROR]', e);
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
