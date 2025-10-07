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
    const dry  = ['1','true','yes'].includes((q.get('dry')||'').toLowerCase());
    const mode = (q.get('mode')||'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days    = q.get('days')    ? Number(q.get('days'))    : null;
    const limit   = q.get('limit')   ? Number(q.get('limit'))   : 5;
    const lang    = (q.get('lang')||'en').toLowerCase(); // 'en' | 'ar'

    const windowMin = minutes ?? (days ? days * 1440 : 1440);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    // --- env ---
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'missing_bot_token' });

    // --- subscribers ---
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({ ok: true, source: 'manual', subs: 0, events_total: 0, events_after_filters: 0, sent: 0, windowMin, mode, limit, dry });
    }

    // --- read manual ZSET by score window; fallback to full range if provider ignores byScore ---
    let members = await kv.zrange('econ:manual', now, end, { byScore: true });
    if (!Array.isArray(members) || !members.length) {
      const allRange = await kv.zrange('econ:manual', 0, -1);
      members = Array.isArray(allRange) ? allRange : [];
    }

    const all = members.map(s => {
      try { const o = JSON.parse(s); o.ts = Date.parse(o.date); return o; } catch { return null; }
    }).filter(e => e && Number.isFinite(e.ts));

    // --- filters ---
    const whitelist = new Set(['United States','Euro Area','United Kingdom','Japan','China']);
    const majors = ['CPI','NFP','FOMC','RATE','RATES','INTEREST','GDP','PMI','ECB','BOE','FED','NON-FARM','NONFARM','UNEMPLOYMENT','PPI','CORE'];

    const inWindow = all.filter(e => e.ts >= now && e.ts <= end);
    const afterFilters = inWindow
      .filter(e => whitelist.has(e.country) && (mode === 'all' || majors.some(k => String(e.event).toUpperCase().includes(k))))
      .sort((a,b) => a.ts - b.ts)
      .slice(0, Math.max(1, limit));

    // cache for /econ_upcoming
    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: afterFilters }), { ex: 60 });

    // --- send ---
    let sent = 0;
    if (!dry && afterFilters.length) {
      for (const ev of afterFilters) {
        const when = new Date(ev.ts);
        const timeStr = new Intl.DateTimeFormat('en-GB', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Dubai' }).format(when);
        const text = (lang === 'ar')
          ? `🔔 *${ev.country}*: ${ev.event}\n⏰ ${timeStr}\n${ev.forecast?`التوقع: ${ev.forecast}\n`:''}${ev.previous?`السابق: ${ev.previous}`:''}`
          : `🔔 *${ev.country}: ${ev.event}*\n⏰ ${timeStr}\n${ev.forecast?`Forecast: ${ev.forecast}\n`:''}${ev.previous?`Previous: ${ev.previous}`:''}`;

        for (const chatId of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_notification: true })
          });
          sent++;
        }
      }
    }

    return res.json({
      ok: true, source: 'manual', subs: validSubs.length,
      events_total: all.length, events_after_filters: afterFilters.length,
      sent, windowMin, mode, limit, dry
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
