// api/cron.js
'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    // ---- auth
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ---- params
    const q = new URL(req.url, 'http://x').searchParams;
    const dry = ['1', 'true'].includes((q.get('dry') || '').toLowerCase());
    const mode = (q.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days = q.get('days') ? Number(q.get('days')) : null;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 5;
    const lang = (q.get('lang') || 'en').toLowerCase(); // 'en' | 'ar'

    const windowMin = minutes ?? (days ? days * 1440 : 1440);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'missing_bot_token' });

    // ---- subscribers
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({ ok: true, source: 'manual', subs: 0, events_total: 0, events_after_filters: 0, sent: 0, windowMin, mode, limit, dry });
    }

    // ---- read manual events (defensive)
    let raw = await kv.zrange('econ:manual', 0, -1);      // by index
    let readMode = 'index';
    if (!raw || !raw.length) {
      // Some environments behave oddly with -1; try a big stop
      raw = await kv.zrange('econ:manual', 0, 99999);
      readMode = 'index_fallback';
    }
    if (!raw || !raw.length) {
      // final fallback: by score in the entire range
      try {
        raw = await kv.zrange('econ:manual', '-inf', '+inf', { byScore: true });
        readMode = 'score';
      } catch {
        // old SDKs may not support { byScore: true }
      }
    }

    const all = (raw || [])
      .map(s => {
        try {
          const o = typeof s === 'string' ? JSON.parse(s) : s;
          o.ts = Date.parse(o.date);
          return Number.isFinite(o.ts) ? o : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);

    const events_total = all.length;

    // ---- time + importance filters
    const inWindow = all.filter(e => e.ts >= now && e.ts <= end);

    const allow = new Set(['United States', 'Euro Area', 'United Kingdom', 'Japan', 'China']);
    const majors = ['CPI','NFP','FOMC','RATE','RATES','INTEREST','GDP','PMI','ECB','BOE','FED','NON-FARM','NONFARM'];

    const filtered = inWindow.filter(e => {
      if (!allow.has(e.country)) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return majors.some(k => txt.includes(k));
    }).slice(0, limit);

    // cache for /api/econ/upcoming
    await kv.set(
      'econ:cache:upcoming',
      JSON.stringify({ at: Date.now(), items: filtered }),
      { ex: 60 }
    );

    // nothing to send
    if (!filtered.length) {
      return res.json({
        ok: true, source: 'manual', subs: validSubs.length,
        events_total, events_after_filters: 0, sent: 0,
        windowMin, mode, limit, dry, readMode
      });
    }

    // ---- build message(s)
    const fmt = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
    });

    const toMsg = (ev) => {
      const when = fmt.format(new Date(ev.ts));
      if (lang === 'ar') {
        return `🔔 *${ev.country}*: ${ev.event}\n⏰ ${when}\n${ev.forecast ? `التوقع: ${ev.forecast}\n` : ''}${ev.previous ? `السابق: ${ev.previous}` : ''}`;
      }
      return `🔔 *${ev.country}: ${ev.event}*\n⏰ ${when}\n${ev.forecast ? `Forecast: ${ev.forecast}\n` : ''}${ev.previous ? `Previous: ${ev.previous}` : ''}`;
    };

    // ---- send
    let sent = 0;
    if (!dry) {
      for (const ev of filtered) {
        const text = toMsg(ev);
        for (const chatId of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
          });
          sent++;
        }
      }
    }

    return res.json({
      ok: true, source: 'manual', subs: validSubs.length,
      events_total, events_after_filters: filtered.length, sent,
      windowMin, mode, limit, dry, readMode
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
