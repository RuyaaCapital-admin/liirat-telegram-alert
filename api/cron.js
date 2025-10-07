// api/cron.js - Economic calendar alerts with Trading Economics API
// Auto-triggers: Runs every 5 min, sends alerts 5-60 min before events
// Real data from Trading Economics (primary) or Manual (fallback)

'use strict';

const { kv } = require('@vercel/kv');

// ============================================================================
// PROVIDER ADAPTERS
// ============================================================================

/**
 * Fetch events from Trading Economics
 * Endpoint: /calendar
 * Docs: https://docs.tradingeconomics.com/economic_calendar/
 */
async function fetchTradingEconomics(fromMs, toMs) {
  const key = process.env.TRADING_ECONOMICS_API_KEY;
  if (!key) return null;

  const from = new Date(fromMs).toISOString().split('T')[0];
  const to = new Date(toMs).toISOString().split('T')[0];
  
  // Trading Economics format: ?c={key}&d1={date}&d2={date}
  const url = `https://api.tradingeconomics.com/calendar?c=${key}&d1=${from}&d2=${to}&f=json`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.error('Trading Economics API error:', res.status, await res.text());
      return null;
    }
    const events = await res.json();
    
    // Trading Economics returns: [{
    //   CalendarId, Country, Event, Date, Actual, Previous, Forecast, TEForecast, Importance
    // }]
    return events.map(e => ({
      country: normalizeCountry(e.Country),
      event: e.Event || 'Unknown Event',
      date: e.Date, // Already ISO format
      forecast: e.Forecast || e.TEForecast || null,
      previous: e.Previous || null,
      impact: mapImportance(e.Importance)
    })).filter(e => e.country);
  } catch (err) {
    console.error('Trading Economics fetch failed:', err.message);
    return null;
  }
}

/**
 * Map Trading Economics Importance (1-3) to impact level
 * 1 = Low, 2 = Medium, 3 = High
 */
function mapImportance(importance) {
  if (importance === 3) return 'high';
  if (importance === 2) return 'medium';
  return 'low';
}

/**
 * Normalize country names
 */
function normalizeCountry(name) {
  const map = {
    'United States': 'United States',
    'Euro Area': 'Euro Area',
    'United Kingdom': 'United Kingdom',
    'Japan': 'Japan',
    'China': 'China',
    'Germany': 'Germany',
    'France': 'France',
    'Canada': 'Canada',
    'Australia': 'Australia',
    'Switzerland': 'Switzerland',
    'India': 'India',
    'Brazil': 'Brazil'
  };
  
  return map[name] || null;
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
    const langParam = (q.get('lang') || 'both').toLowerCase();
    const source = (q.get('source') || 'provider').toLowerCase();

    // Default: alert window 5-60 min
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

    // ---- Fetch Events -------------------------------------------------------
    let providerEvents = [];
    let manualEvents = [];
    let providerUsed = 'none';

    if (source === 'provider') {
      providerEvents = await fetchTradingEconomics(now, end);
      if (providerEvents && providerEvents.length > 0) {
        providerUsed = 'tradingeconomics';
      } else {
        providerEvents = [];
      }
    }

    // Always merge manual events
    manualEvents = await fetchManual(now, end);

    // Combine and deduplicate
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
    const cacheEnd = now + 24 * 60 * 60 * 1000;
    let cacheEvents = [];
    if (source === 'provider') {
      let provCache = await fetchTradingEconomics(now, cacheEnd);
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
    const countryFlags = {
      'United States': '🇺🇸',
      'Euro Area': '🇪🇺',
      'United Kingdom': '🇬🇧',
      'Japan': '🇯🇵',
      'China': '🇨🇳',
      'Germany': '🇩🇪'
    };

    const fmtEn = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
    });

    function toMsg(ev) {
      const when = fmtEn.format(new Date(ev.ts));
      const flag = countryFlags[ev.country] || '🌐';
      const countryEn = ev.country;
      const eventName = ev.event;
      const forecast = ev.forecast;
      const previous = ev.previous;

      // Match your screenshot format
      const lines = [];
      lines.push(`${flag} ${countryEn}: ${eventName}`);
      lines.push(`⏰ ${when} (Asia/Dubai)`);
      if (forecast) lines.push(`Forecast: ${forecast}`);
      if (previous) lines.push(`Previous: ${previous}`);
      
      return lines.join('\n');
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
            body: JSON.stringify({ chat_id: chatId, text })
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
