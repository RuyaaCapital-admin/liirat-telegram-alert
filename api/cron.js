// api/cron.js
//
// This handler drives the scheduled delivery of economic alerts.  It reads upcoming
// events from a Redis sorted set, filters them by a rolling window and a set of
// countries/keywords, caches the next few items for the `/api/econ/upcoming`
// endpoint and then broadcasts formatted messages to all subscribers.  A simple
// deduplication layer prevents the same alert from being sent twice in the
// same minute across multiple cron executions.  Messages can be rendered in
// English, Arabic or bilingual form by supplying `?lang=en`, `?lang=ar` or
// `?lang=both`.

'use strict';

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  try {
    // ---- authentication -----------------------------------------------------
    // Require the cron secret on every invocation.  Vercel Cron attaches
    // Authorization: Bearer <CRON_SECRET> automatically.  Reject anything
    // else to prevent abuse.
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ---- parameter parsing --------------------------------------------------
    const q = new URL(req.url, 'http://x').searchParams;
    const dry    = ['1', 'true'].includes((q.get('dry') || '').toLowerCase());
    const mode   = (q.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days    = q.get('days') ? Number(q.get('days')) : null;
    const limit   = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 5;
    const langParam = (q.get('lang') || 'en').toLowerCase(); // 'en' | 'ar' | 'both' | 'bi'

    // Determine the look‑ahead window.  If minutes is supplied use it,
    // otherwise convert days into minutes.  Fall back to 24h.
    const windowMin = minutes ?? (days ? days * 1440 : 1440);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    // Bot token may live in either LIIRAT_BOT_TOKEN or TG_BOT_TOKEN.  Abort if
    // neither is set.  It is important not to leak the actual token string.
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'missing_bot_token' });
    }

    // ---- load subscribers ---------------------------------------------------
    // Subscribers are stored in a set of string chat IDs.  Remove anything
    // that doesn’t look numeric for safety.
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({
        ok: true, source: 'manual', subs: 0, events_total: 0,
        events_after_filters: 0, sent: 0, windowMin, mode, limit, dry
      });
    }

    // ---- read scheduled events from Redis ----------------------------------
    // Upstash KV occasionally behaves differently depending on the client
    // version.  Attempt to fetch by index first, fall back to a large slice
    // and finally by score if supported.
    let raw = await kv.zrange('econ:manual', 0, -1);
    let readMode = 'index';
    if (!raw || !raw.length) {
      raw = await kv.zrange('econ:manual', 0, 99999);
      readMode = 'index_fallback';
    }
    if (!raw || !raw.length) {
      try {
        raw = await kv.zrange('econ:manual', '-inf', '+inf', { byScore: true });
        readMode = 'score';
      } catch {
        // older SDKs may not support byScore, ignore any error
      }
    }

    const all = (raw || [])
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
      .sort((a, b) => a.ts - b.ts);

    const events_total = all.length;

    // ---- window and importance filtering ------------------------------------
    const inWindow = all.filter(e => e.ts >= now && e.ts <= end);

    // Maintain configurable lists of allowed countries and high‑impact keywords
    const ALLOW_COUNTRIES = ['United States', 'Euro Area', 'United Kingdom', 'Japan', 'China'];
    const MAJOR_KEYWORDS = ['CPI','NFP','FOMC','RATE','RATES','INTEREST','GDP','PMI','ECB','BOE','FED','NON-FARM','NONFARM'];

    const filtered = inWindow.filter(e => {
      if (!ALLOW_COUNTRIES.includes(e.country)) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return MAJOR_KEYWORDS.some(k => txt.includes(k));
    }).slice(0, limit);

    // ---- cache next events for /api/econ/upcoming ---------------------------
    // Store only the limited list of upcoming events.  Use a TTL around
    // 5 minutes (300s) so clients always see something but aren’t reliant on
    // perfect cron timing.
    await kv.set(
      'econ:cache:upcoming',
      JSON.stringify({ at: Date.now(), items: filtered }),
      { ex: 300 }
    );

    // Early exit if nothing remains to send
    if (!filtered.length) {
      return res.json({
        ok: true, source: 'manual', subs: validSubs.length,
        events_total, events_after_filters: 0, sent: 0,
        windowMin, mode, limit, dry, readMode
      });
    }

    // ---- message formatting -------------------------------------------------
    // Arabic translations for country names.  If a translation is missing
    // fallback to the English name.  These translations cover the
    // currently allowed set of countries.
    const countryAr = {
      'United States': 'الولايات المتحدة',
      'Euro Area': 'منطقة اليورو',
      'United Kingdom': 'المملكة المتحدة',
      'Japan': 'اليابان',
      'China': 'الصين'
    };

    // Formatter for dates in Asia/Dubai time zone.  We attach the explicit
    // time‑zone label manually because Intl.DateTimeFormat does not include
    // it by default.  Should the region change, adjust here.
    const fmtEn = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
    });

    /**
     * Build a message for a single event based on the requested language.
     * Supported values:
     *   - 'ar': Arabic only
     *   - 'both' or 'bi': bilingual (Arabic | English)
     *   - default: English only
     *
     * Messages include a bell emoji, the country and event name, a time
     * string and any available forecast/previous figures.  For bilingual
     * messages Arabic precedes English separated by a vertical bar.
     *
     * @param {Object} ev Event with ts, country, event, forecast, previous
     */
    function toMsg(ev) {
      const when = fmtEn.format(new Date(ev.ts)) + ' (Asia/Dubai)';
      const countryEn = ev.country;
      const countryArName = countryAr[ev.country] || ev.country;
      const eventName = ev.event;
      const forecast = ev.forecast;
      const previous = ev.previous;

      // Arabic only
      if (langParam === 'ar') {
        let txt = `🔔 ${countryArName}: ${eventName}\n⏰ ${when}`;
        if (forecast) txt += `\nالتوقع: ${forecast}`;
        if (previous) txt += `\nالسابق: ${previous}`;
        return txt;
      }
      // bilingual (both or bi)
      if (langParam === 'both' || langParam === 'bi') {
        const lines = [];
        lines.push(`🔔 ${countryArName}: ${eventName} | ${countryEn}: ${eventName}`);
        lines.push(`⏰ ${when}`);
        if (forecast) lines.push(`التوقع: ${forecast} | Forecast: ${forecast}`);
        if (previous) lines.push(`السابق: ${previous} | Previous: ${previous}`);
        return lines.join('\n');
      }
      // default English
      let txt = `🔔 ${countryEn}: ${eventName}\n⏰ ${when}`;
      if (forecast) txt += `\nForecast: ${forecast}`;
      if (previous) txt += `\nPrevious: ${previous}`;
      return txt;
    }

    // ---- deduplication ------------------------------------------------------
    // Use a per‑event key keyed on country, event and the ISO minute to
    // prevent accidental duplicate sends across cron runs.  Keys expire
    // automatically after 48 hours (48*3600 seconds).
    const DEDUPE_EXPIRY = 48 * 60 * 60;

    let sent = 0;
    if (!dry) {
      for (const ev of filtered) {
        // Build dedupe key using the ISO minute (YYYY-MM-DDTHH:MM).  This
        // coarse granularity groups together any occurrences within the same
        // minute.
        const isoMinute = new Date(ev.ts).toISOString().slice(0, 16);
        const dedupeKey = `econ:sent:${ev.country}|${ev.event}|${isoMinute}`;
        try {
          const already = await kv.get(dedupeKey);
          if (already) {
            continue;
          }
        } catch {
          // ignore lookup errors, default to sending
        }

        const text = toMsg(ev);
        for (const chatId of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
          });
          sent++;
        }
        try {
          await kv.set(dedupeKey, '1', { ex: DEDUPE_EXPIRY });
        } catch {
          // if dedupe write fails it is not fatal
        }
      }
    }

    // ---- result summary -----------------------------------------------------
    return res.json({
      ok: true, source: 'manual', subs: validSubs.length,
      events_total, events_after_filters: filtered.length, sent,
      windowMin, mode, limit, dry, readMode
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
