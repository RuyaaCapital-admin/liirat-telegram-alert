// api/econ/upcoming.js
//
// Returns a short list of upcoming economic events for the next day.  The
// result is formatted in both Arabic and English and is intended for
// consumption by the Voiceflow /econ_upcoming intent or any other client
// wishing to display a preview of future alerts.  The handler does not
// enforce authorization; you may add a simple check if desired.  It first
// attempts to serve cached data populated by api/cron.js.  When the cache
// is missing it falls back to reading all scheduled events, filters them
// into the next 24h window, sorts them and truncates to the requested
// limit.

'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 5;

    // Attempt to read the cached list of upcoming events.  The cache is set
    // by cron.js with a TTL of ~5 minutes.  Ignore any parse errors.
    let cache;
    try {
      const raw = await kv.get('econ:cache:upcoming');
      cache = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch {
      cache = null;
    }
    let items = Array.isArray(cache?.items) ? cache.items : [];

    // If there is no cache or it’s empty then build the list manually.  The
    // fallback reads all scheduled events by index (with fallbacks) and
    // filters those that occur within the next 24 hours.  This mirrors
    // cron.js’s read logic to remain robust across client versions.
    if (!items.length) {
      const now = Date.now();
      const end = now + 24 * 60 * 60 * 1000;
      let rawEvents = await kv.zrange('econ:manual', 0, -1);
      let mode = 'index';
      if (!rawEvents || !rawEvents.length) {
        rawEvents = await kv.zrange('econ:manual', 0, 99999);
        mode = 'index_fallback';
      }
      if (!rawEvents || !rawEvents.length) {
        try {
          rawEvents = await kv.zrange('econ:manual', '-inf', '+inf', { byScore: true });
          mode = 'score';
        } catch {
          // ignore byScore errors
        }
      }
      const all = (rawEvents || [])
        .map(s => {
          try {
            const o = typeof s === 'string' ? JSON.parse(s) : s;
            o.ts = Date.parse(o.date);
            return Number.isFinite(o.ts) ? o : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter(e => e.ts >= now && e.ts <= end)
        .sort((a, b) => a.ts - b.ts);
      items = all;
    }

    items = items.slice(0, limit);

    // Prepare bilingual lines for each event.  Use the same translations
    // defined in cron.js for consistency.  If a translation is missing use
    // the English name.  The time is rendered with the Asia/Dubai time zone.
    const countryAr = {
      'United States': 'الولايات المتحدة',
      'Euro Area': 'منطقة اليورو',
      'United Kingdom': 'المملكة المتحدة',
      'Japan': 'اليابان',
      'China': 'الصين'
    };
    const fmtEn = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
    });

    const lines = items.map((ev, i) => {
      const when = fmtEn.format(new Date(ev.ts)) + ' (Asia/Dubai)';
      const countryEn = ev.country;
      const countryArName = countryAr[ev.country] || ev.country;
      const eventName = ev.event;
      const forecast = ev.forecast;
      const previous = ev.previous;
      const parts = [];
      parts.push(`${i + 1}. 🔔 ${countryArName}: ${eventName} | ${countryEn}: ${eventName}`);
      parts.push(`   ⏰ ${when}`);
      if (forecast) parts.push(`   التوقع: ${forecast} | Forecast: ${forecast}`);
      if (previous) parts.push(`   السابق: ${previous} | Previous: ${previous}`);
      return parts.join('\n');
    });

    const text =
      items.length
        ? `🔔 الأحداث الاقتصادية القادمة / Upcoming Economic Events\n\n${lines.join('\n\n')}`
        : `لا توجد أحداث قادمة خلال الفترة المحددة.\nNo upcoming events in the selected window.`;

    return res.json({ ok: true, count: items.length, items, text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
