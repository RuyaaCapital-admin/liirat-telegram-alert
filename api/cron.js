// api/cron.js
'use strict';

const { kv } = require('@vercel/kv');

// helper: map short codes to TE-style country names
const CODE_MAP = {
  US: 'United States',
  EA: 'Euro Area',
  UK: 'United Kingdom',
  JP: 'Japan',
  CN: 'China'
};
const DEFAULT_COUNTRIES = ['United States', 'Euro Area', 'United Kingdom'];
const MAJORS = ['CPI', 'NFP', 'FOMC', 'RATE', 'RATES', 'INTEREST', 'GDP', 'PMI', 'ECB', 'BOE', 'FED', 'NON-FARM', 'NONFARM'];

module.exports = async function handler(req, res) {
  try {
    // --- auth ---
    const okAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    if (!okAuth) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // --- query params ---
    const q = new URL(req.url, 'http://x').searchParams;
    const dry = q.get('dry') === '1' || q.get('dry') === 'true';
    const mode = (q.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days = q.get('days') ? Number(q.get('days')) : null;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 5;

    // countries: "US,EA,UK" or full names
    let countries = DEFAULT_COUNTRIES;
    if (q.get('countries')) {
      countries = q
        .get('countries')
        .split(',')
        .map(s => s.trim())
        .map(s => CODE_MAP[s.toUpperCase()] || s)
        .filter(Boolean);
    }
    const COUNTRY_SET = new Set(countries);

    const windowMin = minutes ?? (days ? days * 1440 : 1440);
    const nowMs = Date.now();
    const endMs = nowMs + windowMin * 60 * 1000;

    // --- env ---
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'missing_bot_token' });

    // --- subscribers ---
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({
        ok: true, source: 'manual', subs: 0,
        events_total: 0, events_after_filters: 0, sent: 0,
        windowMin, mode, countries, limit, dry
      });
    }

    // --- read manual events scheduled in [now, end] by SCORE ---
    // NOTE: members are JSON strings; score is UTC ms (Number).
    let manualRaw = [];
    try {
      manualRaw = await kv.zrange('econ:manual', nowMs, endMs, { byScore: true });
      if (!Array.isArray(manualRaw)) manualRaw = [];
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'kv zrange byScore failed', message: String(e) });
    }

    const all = manualRaw.map(s => {
      try {
        const o = JSON.parse(s);
        o.ts = Date.parse(o.date);
        return (Number.isFinite(o.ts) ? o : null);
      } catch { return null; }
    }).filter(Boolean);

    // --- filters ---
    const filtered = all.filter(e => {
      if (!COUNTRY_SET.has(e.country)) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return MAJORS.some(k => txt.includes(k));
    }).sort((a, b) => a.ts - b.ts).slice(0, limit);

    // cache upcoming for /econ_upcoming (TTL 60s)
    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: filtered }), { ex: 60 });

    if (!filtered.length) {
      return res.json({
        ok: true, source: 'manual', subs: validSubs.length,
        events_total: all.length, events_after_filters: 0, sent: 0,
        windowMin, mode, countries, limit, dry
      });
    }

    // --- send ---
    let sent = 0;
    for (const ev of filtered) {
      const when = new Date(ev.ts);
      const timeStr = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
      }).format(when);

      const lineForecast = ev.forecast ? `توقع: ${ev.forecast} | Forecast: ${ev.forecast}\n` : '';
      const linePrev = ev.previous ? `السابق: ${ev.previous} | Previous: ${ev.previous}\n` : '';

      const msg =
`🔔 *${ev.country}: ${ev.event}*
⏰ ${timeStr}
${lineForecast}${linePrev}`.trim();

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
      events_total: all.length, events_after_filters: filtered.length,
      sent, windowMin, mode, countries, limit, dry
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
