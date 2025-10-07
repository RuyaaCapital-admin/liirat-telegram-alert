// api/cron.js - Economic calendar alerts with live provider support
// Auto-triggers: Runs every 5 min, sends alerts 5-60 min before events
// Real data from Finnhub (primary) or FMP (fallback)
// Manual events (econ:manual) always merged as override layer

'use strict';

const { kv } = require('@vercel/kv');

// ============================================================================
// PROVIDER ADAPTERS
// ============================================================================

/**
 * Fetch events from Finnhub
 * Free tier: 60 calls/min, economic calendar included
 * Endpoint: /calendar/economic?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
async function fetchFinnhub(fromMs, toMs) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const from = new Date(fromMs).toISOString().split('T')[0];
  const to = new Date(toMs).toISOString().split('T')[0];
  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    
    // Finnhub returns { economicCalendar: [{time, country, event, actual, estimate, prev, impact}] }
    const events = data.economicCalendar || [];
    
    return events.map(e => ({
      country: normalizeCountry(e.country),
      event: e.event || 'Unknown Event',
      date: new Date(e.time * 1000).toISOString(), // Unix timestamp to ISO
      forecast: e.estimate || null,
      previous: e.prev || null,
      impact: e.impact || 'unknown'
    })).filter(e => e.country); // Drop events with unmapped countries
  } catch {
    return null;
  }
}

/**
 * Fetch events from Financial Modeling Prep
 * Note: Free tier may block this endpoint (403)
 * Endpoint: /economic_calendar
 */
async function fetchFMP(fromMs, toMs) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;

  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?apikey=${key}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const events = await res.json();
    
    // FMP returns [{date, country, event, estimate, previous, impact}]
    return events
      .filter(e => {
        const ts = Date.parse(e.date);
        return ts >= fromMs && ts <= toMs;
      })
      .map(e => ({
        country: normalizeCountry(e.country),
        event: e.event || 'Unknown Event',
        date: new Date(e.date).toISOString(),
        forecast: e.estimate || null,
        previous: e.previous || null,
        impact: e.impact || 'unknown'
      }))
      .filter(e => e.country);
  } catch {
    return null;
  }
}

/**
 * Normalize country codes to full names
 * Maps common codes (US, GB, EA, EU, JP, CN, DE) to display names
 */
function normalizeCountry(code) {
  const map = {
    'US': 'United States',
    'USA': 'United States',
    'United States': 'United States',
    'EA': 'Euro Area',
    'EU': 'Euro Area',
    'EUR': 'Euro Area',
    'Euro Area': 'Euro Area',
    'Eurozone': 'Euro Area',
    'GB': 'United Kingdom',
    'UK': 'United Kingdom',
    'United Kingdom': 'United Kingdom',
    'JP': 'Japan',
    'JPN': 'Japan',
    'Japan': 'Japan',
    'CN': 'China',
    'CHN': 'China',
    'China': 'China',
    'DE': 'Germany',
    'DEU': 'Germany',
    'Germany': 'Germany'
  };
  
  return map[code] || map[String(code).toUpperCase()] || null;
}

/**
 * Fetch events from manual storage (admin-inserted test events)
 */
async function fetchManual(fromMs, toMs) {
  try {
    let raw = await kv.zrange('econ:manual', 0, -1);
    if (!raw || !raw.length) {
      raw = await kv.zrange('econ:manual', 0, 99999);
    }
    if (!raw || !raw.length) {
      try {
        raw = await kv.zrange('econ:manual', '-inf', '+inf', { byScore: true });
      } catch {}
    }

    return (raw || [])
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
      .filter(e => e.ts >= fromMs && e.ts <= toMs);
  } catch {
    return [];
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async function handler(req, res) {
  try {
    // ---- Authentication -----------------------------------------------------
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ---- Parameter Parsing --------------------------------------------------
    const q = new URL(req.url, 'http://x').searchParams;
    const dry = ['1', 'true'].includes((q.get('dry') || '').toLowerCase());
    const mode = (q.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days = q.get('days') ? Number(q.get('days')) : null;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 10;
    const langParam = (q.get('lang') || 'both').toLowerCase(); // 'en' | 'ar' | 'both' | 'bi'
    const source = (q.get('source') || 'provider').toLowerCase(); // 'provider' | 'manual'

    // Default: alert window 5-60 min (auto-trigger before events)
    // Cron runs every 5 min, so events 5-60 min away get alerted
    const windowMin = minutes ?? (days ? days * 1440 : 60);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'missing_bot_token' });
    }

    // ---- Load Subscribers ---------------------------------------------------
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({
        ok: true, source: 'none', subs: 0, events_total: 0,
        events_after_filters: 0, sent: 0, windowMin, mode, limit, dry
      });
    }

    // ---- Fetch Events from Provider or Manual -------------------------------
    let providerEvents = [];
    let manualEvents = [];
    let providerUsed = 'none';

    if (source === 'provider') {
      // Try Finnhub first, then FMP
      providerEvents = await fetchFinnhub(now, end);
      if (providerEvents && providerEvents.length > 0) {
        providerUsed = 'finnhub';
      } else {
        providerEvents = await fetchFMP(now, end);
        if (providerEvents && providerEvents.length > 0) {
          providerUsed = 'fmp';
        } else {
          providerEvents = [];
        }
      }
    }

    // Always merge manual events (override layer)
    manualEvents = await fetchManual(now, end);

    // Combine and deduplicate by country+event+date
    const combined = [...providerEvents, ...manualEvents];
    const uniqueMap = new Map();
    for (const ev of combined) {
      const key = `${ev.country}|${ev.event}|${new Date(ev.date).toISOString().slice(0, 16)}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, { ...ev, ts: Date.parse(ev.date) });
      }
    }
    
    const all = Array.from(uniqueMap.values()).sort((a, b) => a.ts - b.ts);
    const events_total = all.length;

    // ---- Filtering ----------------------------------------------------------
    const ALLOW_COUNTRIES = ['United States', 'Euro Area', 'United Kingdom', 'Japan', 'China', 'Germany'];
    const MAJOR_KEYWORDS = ['CPI','NFP','FOMC','RATE','RATES','INTEREST','GDP','PMI','ECB','BOE','FED','NON-FARM','NONFARM','UNEMPLOYMENT','JOBLESS','RETAIL','SALES','INFLATION','PAYROLL','EMPLOYMENT'];

    const filtered = all.filter(e => {
      if (!ALLOW_COUNTRIES.includes(e.country)) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return MAJOR_KEYWORDS.some(k => txt.includes(k));
    }).slice(0, limit);

    // ---- Cache for /api/econ/upcoming ---------------------------------------
    // Cache next 24h events (not just alert window) so /econ_upcoming shows more
    const cacheEnd = now + 24 * 60 * 60 * 1000;
    let cacheEvents = [];
    if (source === 'provider') {
      let provCache = await fetchFinnhub(now, cacheEnd);
      if (!provCache || !provCache.length) provCache = await fetchFMP(now, cacheEnd);
      cacheEvents = [...(provCache || []), ...(await fetchManual(now, cacheEnd))];
    } else {
      cacheEvents = await fetchManual(now, cacheEnd);
    }
    
    const cacheMap = new Map();
    for (const ev of cacheEvents) {
      const key = `${ev.country}|${ev.event}|${new Date(ev.date).toISOString().slice(0, 16)}`;
      if (!cacheMap.has(key)) {
        cacheMap.set(key, { ...ev, ts: Date.parse(ev.date) });
      }
    }
    const cacheFiltered = Array.from(cacheMap.values())
      .filter(e => ALLOW_COUNTRIES.includes(e.country))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 20);

    await kv.set(
      'econ:cache:upcoming',
      JSON.stringify({ at: Date.now(), items: cacheFiltered }),
      { ex: 300 }
    );

    if (!filtered.length) {
      return res.json({
        ok: true, provider: providerUsed, subs: validSubs.length,
        events_total, events_after_filters: 0, sent: 0,
        windowMin, mode, limit, dry
      });
    }

    // ---- Message Formatting -------------------------------------------------
    const countryAr = {
      'United States': 'الولايات المتحدة',
      'Euro Area': 'منطقة اليورو',
      'United Kingdom': 'المملكة المتحدة',
      'Japan': 'اليابان',
      'China': 'الصين',
      'Germany': 'ألمانيا'
    };

    const fmtEn = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
    });

    function toMsg(ev) {
      const when = fmtEn.format(new Date(ev.ts)) + ' (Asia/Dubai)';
      const countryEn = ev.country;
      const countryArName = countryAr[ev.country] || ev.country;
      const eventName = ev.event;
      const forecast = ev.forecast;
      const previous = ev.previous;

      if (langParam === 'ar') {
        let txt = `🔔 ${countryArName}: ${eventName}\n⏰ ${when}`;
        if (forecast) txt += `\nالتوقع: ${forecast}`;
        if (previous) txt += `\nالسابق: ${previous}`;
        return txt;
      }
      if (langParam === 'both' || langParam === 'bi') {
        const lines = [];
        lines.push(`🔔 ${countryArName}: ${eventName} | ${countryEn}: ${eventName}`);
        lines.push(`⏰ ${when}`);
        if (forecast) lines.push(`التوقع: ${forecast} | Forecast: ${forecast}`);
        if (previous) lines.push(`السابق: ${previous} | Previous: ${previous}`);
        return lines.join('\n');
      }
      let txt = `🔔 ${countryEn}: ${eventName}\n⏰ ${when}`;
      if (forecast) txt += `\nForecast: ${forecast}`;
      if (previous) txt += `\nPrevious: ${previous}`;
      return txt;
    }

    // ---- Deduplication & Sending --------------------------------------------
    const DEDUPE_EXPIRY = 48 * 60 * 60;
    let sent = 0;

    if (!dry) {
      for (const ev of filtered) {
        const isoMinute = new Date(ev.ts).toISOString().slice(0, 16);
        const dedupeKey = `econ:sent:${ev.country}|${ev.event}|${isoMinute}`;
        
        try {
          const already = await kv.get(dedupeKey);
          if (already) continue;
        } catch {}

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
        } catch {}
      }
    }

    // ---- Result Summary -----------------------------------------------------
    return res.json({
      ok: true, 
      provider: providerUsed,
      subs: validSubs.length,
      events_total, 
      events_from_provider: providerEvents.length,
      events_from_manual: manualEvents.length,
      events_after_filters: filtered.length, 
      sent,
      windowMin, 
      mode, 
      limit, 
      dry
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
