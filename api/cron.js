// api/cron.js - Economic calendar alerts with Trading Economics API
// Auto-triggers: Runs every 5 min, sends alerts 5-60 min before events
// Rate limit aware: 1 req/sec for free tier

'use strict';

const { kv } = require('@vercel/kv');

// Rate limiting: Trading Economics free tier = 1 req/sec
let lastApiCall = 0;
const MIN_API_INTERVAL = 1100; // 1.1 seconds between calls

async function rateLimitedFetch(url, timeout = 12000) {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < MIN_API_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_API_INTERVAL - elapsed));
  }
  lastApiCall = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(timeout) });
}

// ============================================================================
// PROVIDER ADAPTERS
// ============================================================================

/**
 * Fetch events from Trading Economics
 * FREE TIER LIMITS: 1 req/sec, 500 calls/month
 */
async function fetchTradingEconomics(fromMs, toMs) {
  const key = process.env.TRADING_ECONOMICS_API_KEY;
  if (!key) return null;

  const from = new Date(fromMs).toISOString().split('T')[0];
  const to = new Date(toMs).toISOString().split('T')[0];
  
  const url = `https://api.tradingeconomics.com/calendar?c=${key}&d1=${from}&d2=${to}&f=json`;

  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) {
      const errText = await res.text();
      console.error('Trading Economics API error:', res.status, errText);
      return null;
    }
    const events = await res.json();
    
    return events.map(e => ({
      country: normalizeCountry(e.Country),
      event: e.Event || 'Unknown Event',
      date: e.Date,
      forecast: e.Forecast || e.TEForecast || null,
      previous: e.Previous || null,
      impact: mapImportance(e.Importance)
    })).filter(e => e.country);
  } catch (err) {
    console.error('Trading Economics fetch failed:', err.message);
    return null;
  }
}

function mapImportance(importance) {
  if (importance === 3) return 'high';
  if (importance === 2) return 'medium';
  return 'low';
}

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
    'Switzerland': 'Switzerland'
  };
  return map[name] || null;
}

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
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const q = new URL(req.url, 'http://x').searchParams;
    const dry = ['1', 'true'].includes((q.get('dry') || '').toLowerCase());
    const mode = (q.get('mode') || 'major').toLowerCase();
    const minutes = q.get('minutes') ? Number(q.get('minutes')) : null;
    const days = q.get('days') ? Number(q.get('days')) : null;
    const limit = q.get('limit') ? Math.max(1, Number(q.get('limit'))) : 10;
    const source = (q.get('source') || 'provider').toLowerCase();

    const windowMin = minutes ?? (days ? days * 1440 : 60);
    const now = Date.now();
    const end = now + windowMin * 60 * 1000;

    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'missing_bot_token' });
    }

    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    if (!validSubs.length) {
      return res.json({
        ok: true, source: 'none', subs: 0, events_total: 0,
        events_after_filters: 0, sent: 0, windowMin, mode, limit, dry
      });
    }

    // ---- Fetch Events (rate limited) ----------------------------------------
    let providerEvents = [];
    let manualEvents = [];
    let providerUsed = 'none';

    if (source === 'provider') {
      // Check cache first to avoid API calls
      const cached = await kv.get('econ:api:cache');
      if (cached) {
        try {
          const cacheData = JSON.parse(cached);
          if (Date.now() - cacheData.at < 5 * 60 * 1000) {
            providerEvents = cacheData.events.filter(e => {
              const ts = Date.parse(e.date);
              return ts >= now && ts <= end;
            });
            providerUsed = 'tradingeconomics_cached';
          }
        } catch {}
      }

      // If no cache or expired, fetch new data
      if (!providerEvents.length) {
        // Fetch wider window to cache
        const fetchEnd = now + 24 * 60 * 60 * 1000; // 24h
        providerEvents = await fetchTradingEconomics(now, fetchEnd);
        if (providerEvents && providerEvents.length > 0) {
          providerUsed = 'tradingeconomics';
          // Cache for 5 min
          await kv.set('econ:api:cache', JSON.stringify({
            at: Date.now(),
            events: providerEvents
          }), { ex: 300 });
          // Filter to alert window
          providerEvents = providerEvents.filter(e => {
            const ts = Date.parse(e.date);
            return ts >= now && ts <= end;
          });
        } else {
          providerEvents = [];
        }
      }
    }

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
      // Use same cache to avoid extra API call
      const cached = await kv.get('econ:api:cache');
      if (cached) {
        try {
          const cacheData = JSON.parse(cached);
          cacheEvents = [...cacheData.events, ...(await fetchManual(now, cacheEnd))];
        } catch {}
      }
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
      const lines = [];
      lines.push(`${flag} ${ev.country}: ${ev.event}`);
      lines.push(`⏰ ${when} (Asia/Dubai)`);
      if (ev.forecast) lines.push(`Forecast: ${ev.forecast}`);
      if (ev.previous) lines.push(`Previous: ${ev.previous}`);
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
