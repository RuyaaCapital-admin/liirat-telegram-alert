import { kv } from '@vercel/kv';

// Node runtime (no Edge config)

export default async function handler(req, res) {
  try {
    // ---- Auth ----
    const auth = req.headers.authorization || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!(isCron || auth === `Bearer ${process.env.CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ---- Env ----
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'LIIRAT_BOT_TOKEN missing' });

    // ---- Subscribers ----
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(id => /^\d+$/.test(String(id)));
    if (!validSubs.length) return res.json({ ok: true, sent: 0, reason: 'no valid subscribers' });

    // ---- Parameters ----
    const { searchParams } = new URL(req.url, `https://${req.headers.host || 'localhost'}`);

    // Window (either minutes or days)
    const minutesParam = Number(searchParams.get('minutes') || 0);
    const daysParam = Number(searchParams.get('days') || 2); // default 2 days range
    const windowMin = minutesParam > 0 ? minutesParam : daysParam * 24 * 60;

    // Strict major-only by default; pass mode=all to include broader set
    const mode = (searchParams.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const majorOnly = mode !== 'all';

    // Countries default: US, Euro Area, UK (override with countries=US,EA,UK,JP,CN,CA)
    const countriesParam = (searchParams.get('countries') || 'US,EA,UK').split(',')
      .map(s => s.trim().toUpperCase()).filter(Boolean);
    const COUNTRY_MAP = {
      US: 'United States',
      EA: 'Euro Area',
      EU: 'Euro Area',
      UK: 'United Kingdom',
      JP: 'Japan',
      CN: 'China',
      CA: 'Canada',
      AU: 'Australia',
      CH: 'Switzerland',
      DE: 'Germany',
      FR: 'France'
    };
    const allowedCountries = countriesParam.map(c => COUNTRY_MAP[c] || c);

    // Limit messages per run
    const limit = Math.max(1, Math.min(10, Number(searchParams.get('limit') || 3)));

    const dry = searchParams.get('dry') === '1'; // compute only, no send

    // ---- Fetch TradingEconomics with date range ----
    const now = Date.now();
    const endTs = now + windowMin * 60 * 1000;

    const d1 = new Date(now).toISOString().slice(0, 10);
    const d2 = new Date(endTs).toISOString().slice(0, 10);

    const teKey = process.env.TE_API_KEY || 'guest:guest';
    const teUrl =
      `https://api.tradingeconomics.com/calendar?d1=${d1}&d2=${d2}` +
      `&importance=2,3&c=${encodeURIComponent(teKey)}&f=json`;

    let raw = [];
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(teUrl, { signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'te api error', status: r.status, response: await r.text() });
      }
      raw = await r.json();
      if (!Array.isArray(raw)) raw = [];
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'te fetch error', message: String(e) });
    }

    // ---- Normalize & filter ----
    const parseUTC = (s) => {
      if (!s) return null;
      let d = new Date(s);
      if (!isFinite(d)) d = new Date(String(s).replace(' ', 'T') + 'Z');
      return isFinite(d) ? d : null;
    };

    // Major event keywords (lowercase matching)
    const MAJOR_KEYS = [
      'non-farm payroll', 'nfp',
      'fomc', 'fed interest rate', 'federal funds rate', 'interest rate decision',
      'ecb interest rate', 'boe interest rate', 'bank of england interest rate',
      'cpi', 'consumer price index',
      'core cpi', 'inflation rate',
      'unemployment rate'
    ];

    const isMajor = (evName) => {
      const s = String(evName || '').toLowerCase();
      return MAJOR_KEYS.some(k => s.includes(k));
    };

    const isHighOrMed = (imp) => {
      const s = String(imp ?? '').toLowerCase();
      return s === '3' || s === 'high' || s === '2' || s === 'medium';
    };

    // Normalize TE fields
    const events = raw.map(e => ({
      country: e.Country,
      event: e.Event,
      date: e.Date,
      forecast: e.Forecast,
      previous: e.Previous,
      importance: e.Importance || e.Impact
    })).filter(e => e.country && e.event && isHighOrMed(e.importance));

    // Time window + country filter
    const upcoming = events.filter(e => {
      if (!allowedCountries.includes(e.country)) return false;
      const d = parseUTC(e.date);
      if (!d) return false;
      const ts = d.getTime();
      return ts >= now && ts <= endTs;
    });

    // Major-only filter unless mode=all
    const filtered = majorOnly ? upcoming.filter(e => isMajor(e.event)) : upcoming;

    // Sort & limit
    filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
    const selected = filtered.slice(0, limit);

    // Cache for /econ_upcoming
    await kv.set('econ:cache:upcoming',
      JSON.stringify({ at: Date.now(), items: selected }),
      { ex: 120 }
    );

    // ---- Send ----
    let sent = 0;
    for (const ev of selected) {
      const when = parseUTC(ev.date);
      const whenLocal = when
        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }).format(when)
        : '—';
      const estimate = ev.forecast ? `\nForecast: ${ev.forecast}` : '';
      const previous = ev.previous ? `\nPrevious: ${ev.previous}` : '';

      const text =
`🔔 *${translateCountry(ev.country)} | ${ev.country}*
${ev.event}

⏰ ${whenLocal}${estimate}${previous}

💬 Reply to discuss this with the agent.`;

      // de-dup per event (48h)
      const dedupeKey = `sent:${ev.country}:${ev.event}:${ev.date}`;
      if (await kv.get(dedupeKey)) continue;

      if (!dry) {
        for (const chat_id of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: Number(chat_id),
              text,
              parse_mode: 'Markdown',
              disable_notification: true
            })
          });
          sent++;
        }
      }
      await kv.set(dedupeKey, '1', { ex: 48 * 3600 });
    }

    return res.json({
      ok: true,
      source: 'te',
      subs: validSubs.length,
      events_total: raw.length,
      events_after_filters: filtered.length,
      sent,
      windowMin,
      mode,
      countries: allowedCountries,
      limit,
      dry
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'unexpected', stack: e?.stack });
  }
}

function translateCountry(en) {
  const map = {
    'United States': 'الولايات المتحدة',
    'Euro Area': 'منطقة اليورو',
    'United Kingdom': 'المملكة المتحدة',
    'China': 'الصين',
    'Japan': 'اليابان',
    'Germany': 'ألمانيا',
    'France': 'فرنسا',
    'Canada': 'كندا',
    'Australia': 'أستراليا',
    'Switzerland': 'سويسرا',
    'India': 'الهند',
    'Brazil': 'البرازيل',
    'Mexico': 'المكسيك',
    'South Korea': 'كوريا الجنوبية',
    'Russia': 'روسيا',
    'US': 'الولايات المتحدة',
    'UK': 'المملكة المتحدة'
  };
  return map[en] || en;
}
