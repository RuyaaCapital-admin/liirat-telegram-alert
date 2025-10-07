// api/cron.js - Economic calendar alerts with Trading Economics API
// Auto-triggers: Runs every 15 min, sends alerts 5-60 min before events
// Rate limit aware: 1 req/3sec for free tier (500 calls/month)

'use strict';

const { kv } = require('@vercel/kv');

// Rate limiting: Trading Economics free tier = 500 calls/month
// Space out calls: 1 call per 3 seconds to avoid 429 errors
let lastApiCall = 0;
const MIN_API_INTERVAL = 3000; // 3 seconds between calls

async function rateLimitedFetch(url, timeout = 15000) {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < MIN_API_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_API_INTERVAL - elapsed));
  }
  lastApiCall = Date.now();
  
  console.log('[FETCH] Calling:', url.replace(/c=[^&]+/, 'c=***'));
  return fetch(url, { signal: AbortSignal.timeout(timeout) });
}

// ============================================================================
// PROVIDER ADAPTERS
// ============================================================================

/**
 * Fetch events from Trading Economics
 * FREE TIER LIMITS: 500 calls/month, rate limit unknown (using 3s spacing)
 */
async function fetchTradingEconomics(fromMs, toMs) {
  const key = process.env.TRADING_ECONOMICS_API_KEY;
  if (!key) {
    console.log('[WARN] No TRADING_ECONOMICS_API_KEY found');
    return null;
  }

  const from = new Date(fromMs).toISOString().split('T')[0];
  const to = new Date(toMs).toISOString().split('T')[0];
  
  const url = `https://api.tradingeconomics.com/calendar?c=${key}&d1=${from}&d2=${to}&f=json`;

  try {
    const res = await rateLimitedFetch(url);
    console.log('[API] Trading Economics response:', res.status);
    
    if (!res.ok) {
      const errText = await res.text();
      console.error('[ERROR] Trading Economics API:', res.status, errText);
      return null;
    }
    
    const events = await res.json();
    console.log(`[API] Fetched ${events.length} raw events from Trading Economics`);
    
    // Log all countries found for debugging
    const countriesFound = [...new Set(events.map(e => e.Country))];
    console.log('[API] Countries in response:', countriesFound.join(', '));
    
    const normalized = events.map(e => ({
      country: normalizeCountry(e.Country),
      event: e.Event || 'Unknown Event',
      date: e.Date,
      forecast: e.Forecast || e.TEForecast || null,
      previous: e.Previous || null,
      impact: mapImportance(e.Importance),
      rawCountry: e.Country // Keep for debugging
    })).filter(e => e.country);
    
    console.log(`[API] After country filter: ${normalized.length} events from major countries`);
    if (normalized.length > 0) {
      console.log('[API] Sample events:', normalized.slice(0, 5).map(e => `${e.country}: ${e.event} @ ${e.date}`));
    }
    return normalized;
  } catch (err) {
    console.error('[ERROR] Trading Economics fetch failed:', err.message);
    return null;
  }
}

function mapImportance(importance) {
  if (importance === 3) return 'high';
  if (importance === 2) return 'medium';
  return 'low';
}

function normalizeCountry(name) {
  // TOP 5 MAJOR ECONOMIES ONLY (by GDP)
  const map = {
    'United States': 'United States',
    'China': 'China',
    'Japan': 'Japan',
    'Germany': 'Germany',
    'United Kingdom': 'United Kingdom',
    'Euro Area': 'Euro Area'
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

    const parsed = (raw || [])
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
    
    console.log(`[MANUAL] Fetched ${parsed.length} manual events`);
    return parsed;
  } catch (err) {
    console.error('[ERROR] Manual fetch failed:', err.message);
    return [];
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async function handler(req, res) {
  const startTime = Date.now();
  console.log('\n[CRON START]', new Date().toISOString());
  
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
    
    console.log('[AUTH] Header present:', !!authHeader);
    console.log('[AUTH] Secret configured:', !!process.env.CRON_SECRET);
    
    if (authHeader !== expectedAuth) {
      console.error('[AUTH FAIL] Invalid or missing authorization');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Parse query params
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

    console.log('[PARAMS]', { dry, mode, windowMin, limit, source });

    // Check bot token
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) {
      console.error('[ERROR] No bot token configured');
      return res.status(500).json({ ok: false, error: 'missing_bot_token' });
    }

    // Get subscribers
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(x => /^\d+$/.test(String(x)));
    console.log('[SUBS]', { total: subs.length, valid: validSubs.length, ids: validSubs });
    
    if (!validSubs.length) {
      console.log('[SKIP] No valid subscribers');
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
      // Check cache first (cache until events are past)
      const cacheKey = 'econ:api:cache';
      const cached = await kv.get(cacheKey);
      
      if (cached) {
        try {
          const cacheData = typeof cached === 'string' ? JSON.parse(cached) : cached;
          const cacheAge = Date.now() - cacheData.at;
          console.log(`[CACHE] Found cache, age: ${Math.round(cacheAge / 1000)}s`);
          
          // Use cache for 1 hour (avoid too many API calls)
          if (cacheAge < 60 * 60 * 1000) {
            providerEvents = cacheData.events.filter(e => {
              const ts = Date.parse(e.date);
              return ts >= now && ts <= end;
            });
            providerUsed = 'tradingeconomics_cached';
            console.log(`[CACHE] Using cached data: ${providerEvents.length} events in window`);
          } else {
            console.log('[CACHE] Expired (>1h), fetching fresh data');
          }
        } catch (err) {
          console.error('[CACHE ERROR]', err.message);
        }
      }

      // If no cache or expired, fetch new data
      if (!providerEvents.length || providerUsed === 'none') {
        console.log('[API] Fetching fresh data (7 day window for cache)');
        const fetchEnd = now + 7 * 24 * 60 * 60 * 1000; // 7 days for caching
        const freshData = await fetchTradingEconomics(now, fetchEnd);
        
        if (freshData && freshData.length > 0) {
          providerUsed = 'tradingeconomics';
          console.log(`[API] Got ${freshData.length} events, caching for 1 hour`);
          
          // Cache for 1 hour (3600 seconds)
          await kv.set(cacheKey, JSON.stringify({
            at: Date.now(),
            events: freshData
          }), { ex: 3600 });
          
          // Filter to alert window
          providerEvents = freshData.filter(e => {
            const ts = Date.parse(e.date);
            return ts >= now && ts <= end;
          });
          console.log(`[API] ${providerEvents.length} events in alert window`);
        } else {
          console.log('[API] No events returned or fetch failed');
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
    console.log(`[EVENTS] Total unique: ${events_total}`);

    // ---- Filtering ----------------------------------------------------------
    // Only allow top 5 major economies
    const ALLOW_COUNTRIES = [
      'United States',
      'China', 
      'Japan',
      'Germany',
      'United Kingdom',
      'Euro Area'
    ];
    const MAJOR_KEYWORDS = ['CPI','NFP','FOMC','RATE','RATES','INTEREST','GDP','PMI','ECB','BOE','FED','NON-FARM','NONFARM','UNEMPLOYMENT','JOBLESS','RETAIL','SALES','INFLATION','PAYROLL','EMPLOYMENT'];

    const filtered = all.filter(e => {
      if (!ALLOW_COUNTRIES.includes(e.country)) return false;
      if (mode === 'all') return true;
      const txt = String(e.event || '').toUpperCase();
      return MAJOR_KEYWORDS.some(k => txt.includes(k));
    }).slice(0, limit);

    console.log(`[FILTER] After filters: ${filtered.length} events (mode: ${mode}, limit: ${limit})`);
    if (filtered.length > 0) {
      console.log('[FILTER] Filtered events:', filtered.map(e => `${e.country}: ${e.event} @ ${new Date(e.ts).toISOString()}`));
    }

    // ---- Cache for /api/econ/upcoming ---------------------------------------
    const cacheEnd = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    let cacheEvents = [];
    
    if (source === 'provider') {
      const cached = await kv.get('econ:api:cache');
      if (cached) {
        try {
          const cacheData = typeof cached === 'string' ? JSON.parse(cached) : cached;
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
      .slice(0, 50);

    await kv.set(
      'econ:cache:upcoming',
      JSON.stringify({ at: Date.now(), items: cacheFiltered }),
      { ex: 3600 } // Cache for 1 hour
    );

    if (!filtered.length) {
      console.log('[SKIP] No events after filtering');
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

    console.log(`[SEND] ${dry ? 'DRY RUN' : 'LIVE'} - Processing ${filtered.length} events for ${validSubs.length} subs`);

    if (!dry) {
      for (const ev of filtered) {
        const isoMinute = new Date(ev.ts).toISOString().slice(0, 16);
        const dedupeKey = `econ:sent:${ev.country}|${ev.event}|${isoMinute}`;
        
        try {
          const already = await kv.get(dedupeKey);
          if (already) {
            console.log(`[SKIP] Already sent: ${dedupeKey}`);
            continue;
          }
        } catch {}

        const text = toMsg(ev);
        console.log(`[MSG] Sending to ${validSubs.length} users:`, text.split('\n')[0]);
        
        for (const chatId of validSubs) {
          try {
            const sendRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text })
            });
            
            if (!sendRes.ok) {
              const errData = await sendRes.json();
              console.error(`[TG ERROR] Chat ${chatId}:`, errData);
            } else {
              console.log(`[TG OK] Sent to ${chatId}`);
              sent++;
            }
          } catch (err) {
            console.error(`[TG ERROR] Chat ${chatId}:`, err.message);
          }
        }
        
        try {
          await kv.set(dedupeKey, '1', { ex: DEDUPE_EXPIRY });
          console.log(`[DEDUPE] Marked sent: ${dedupeKey}`);
        } catch (err) {
          console.error(`[DEDUPE ERROR]`, err.message);
        }
      }
    } else {
      console.log('[DRY] Would send:', filtered.map(e => `${e.country}: ${e.event} @ ${new Date(e.ts).toISOString()}`));
    }

    const duration = Date.now() - startTime;
    console.log(`[CRON END] Duration: ${duration}ms, Sent: ${sent} alerts`);

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
      dry,
      duration_ms: duration
    });
  } catch (e) {
    console.error('[FATAL]', e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message, 
      stack: process.env.NODE_ENV === 'development' ? e.stack : undefined 
    });
  }
};
