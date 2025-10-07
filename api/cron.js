// api/cron.js
'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    // --- auth ---
    const okAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    if (!okAuth) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // --- params ---
    const q = new URL(req.url, 'http://x').searchParams;
    const dry = q.get('dry') === '1' || q.get('dry') === 'true';
    const mode = (q.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days = q.get('days') ? Number(q.get('days')) : null;
    const limit = q.get('limit') ? Number(q.get('limit')) : 5;

    const windowMin = minutes ?? (days ? days * 1440 : 1440);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    // --- env ---
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'missing_bot_token' });

    // --- subscribers ---
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length)
      return res.json({ ok: true, source: 'manual', subs: 0, events_total: 0, events_after_filters: 0, sent: 0, windowMin, mode, dry });

    // --- load ALL manual items (index-based), then filter by time ---
    // We store members as JSON strings with a "date" field.
    const raw = (await kv.zrange('econ:manual', 0, -1)) || []; // array of strings
    const all = raw.map(s => {
      try {
        const o = JSON.parse(s);
        o.ts = Date.parse(o.date);
        return o;
      } catch { return null; }
    }).filter(Boolean);

    // time window filter
    const inWindow = all.filter(e => Number.isFinite(e.ts) && e.ts >= now && e.ts <= end);

    // country + importance filters
    const whitelist = new Set(['United States', 'Euro Area', 'United Kingdom']); // extend later if needed
    const majors = ['CPI','NFP','FOMC','rate','rates','interest','GDP','PMI','ECB','BoE','Fed','Non-Farm','Nonfarm'];

    const afterFilters = inWindow.filter(e => {
      const countryOK = whitelist.has(e.country);
      if (!countryOK) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return majors.some(k => txt.includes(k.toUpperCase()));
    }).sort((a,b) => a.ts - b.ts).slice(0, Math.max(1, limit));

    if (!afterFilters.length) {
      // write a tiny cache for your /econ_upcoming later
      await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: [] }), { ex: 60 });
      return res.json({
        ok: true, source: 'manual', subs: validSubs.length,
        events_total: all.length, events_after_filters: 0, sent: 0,
        windowMin, mode, countries: Array.from(whitelist), limit, dry
      });
    }

    // cache upcoming (for a quick /econ_upcoming intent later)
    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: afterFilters }), { ex: 60 });

    // --- build message + send ---
    let sent = 0;
    for (const ev of afterFilters) {
      const when = new Date(ev.ts);
      const timeStr = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
      }).format(when);

      const msg =
`🔔 *${ev.country}: ${ev.event}*
⏰ ${timeStr}
${ev.forecast ? `Forecast: ${ev.forecast}\n` : ''}${ev.previous ? `Previous: ${ev.previous}` : ''}`;

      if (!dry) {
        for (const chatId of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
          });
          sent++;
        }
      }
    }

    return res.json({
      ok: true, source: 'manual', subs: validSubs.length,
      events_total: all.length, events_after_filters: afterFilters.length,
      sent, windowMin, mode, countries: Array.from(whitelist), limit, dry
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
