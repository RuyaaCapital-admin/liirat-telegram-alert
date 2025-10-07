import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!(isCron || auth === `Bearer ${process.env.CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'LIIRAT_BOT_TOKEN missing' });

    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(id => /^\d+$/.test(String(id)));
    if (!validSubs.length) return res.json({ ok: true, sent: 0, reason: 'no_subscribers' });

    const { searchParams } = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const minutesParam = Number(searchParams.get('minutes') || 0);
    const daysParam = Number(searchParams.get('days') || 2);
    const windowMin = minutesParam > 0 ? minutesParam : daysParam * 24 * 60;
    const mode = (searchParams.get('mode') || 'major').toLowerCase(); // 'major' | 'all'
    const majorOnly = mode !== 'all';
    const countriesParam = (searchParams.get('countries') || 'US,EA,UK')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const COUNTRY_MAP = { US:'United States', EA:'Euro Area', EU:'Euro Area', UK:'United Kingdom', JP:'Japan', CN:'China', CA:'Canada', AU:'Australia', CH:'Switzerland', DE:'Germany', FR:'France' };
    const allowedCountries = countriesParam.map(c => COUNTRY_MAP[c] || c);
    const limit = Math.max(1, Math.min(10, Number(searchParams.get('limit') || 3)));
    const dry = searchParams.get('dry') === '1';

    const now = Date.now();
    const endTs = now + windowMin * 60 * 1000;
    const d1 = new Date(now).toISOString().slice(0, 10);
    const d2 = new Date(endTs).toISOString().slice(0, 10);

    // ========== 1) Try TradingEconomics (guest) ==========
    let source = 'te';
    let raw = [];
    {
      const teKey = process.env.TE_API_KEY || 'guest:guest';
      const baseParams = `importance=2,3&c=${encodeURIComponent(teKey)}&f=json`;
      const teUrls = [
        `https://api.tradingeconomics.com/calendar?d1=${d1}&d2=${d2}&${baseParams}`,
        `https://api.tradingeconomics.com/calendar?${baseParams}`
      ];
      for (const u of teUrls) {
        try {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
          const r = await fetch(u, { signal: ac.signal, headers: { accept: 'application/json' } });
          clearTimeout(t);
          if (r.ok) {
            const json = await r.json();
            if (Array.isArray(json) && json.length) { raw = json; break; }
          }
        } catch { /* ignore */ }
      }
    }

    // Helpers
    const parseUTC = (s) => { if (!s) return null; let d = new Date(s); if (!isFinite(d)) d = new Date(String(s).replace(' ', 'T') + 'Z'); return isFinite(d) ? d : null; };
    const isHighOrMed = (imp) => { const s = String(imp ?? '').toLowerCase(); return s === '3' || s === 'high' || s === '2' || s === 'medium'; };
    const MAJOR_KEYS = ['non-farm payroll', 'nfp','fomc','fed interest rate','federal funds rate','interest rate decision','ecb interest rate','boe interest rate','bank of england interest rate','cpi','consumer price index','core cpi','inflation rate','unemployment rate'];
    const isMajor = (name) => { const s = String(name || '').toLowerCase(); return MAJOR_KEYS.some(k => s.includes(k)); };
    const normalizeTE = (row) => ({
      country: row.Country,
      event: row.Event,
      date: row.Date,
      forecast: row.Forecast,
      previous: row.Previous,
      importance: row.Importance || row.Impact
    });

    // ========== 2) If TE empty, use MANUAL KV ==========
    let events = [];
    if (Array.isArray(raw) && raw.length) {
      events = raw.map(normalizeTE);
    } else {
      source = 'manual';
      // fetch manual events within window [now, endTs]
      const manual = await kv.zrangebyscore('econ:manual', now, endTs);
      events = manual.map(m => {
        try { return JSON.parse(m); } catch { return null; }
      }).filter(Boolean).map(e => ({
        country: e.country, event: e.event, date: e.date,
        forecast: e.forecast ?? null, previous: e.previous ?? null, importance: '3'
      }));
    }

    // Filter: importance, country, window
    const filtered = events.filter(e => {
      if (!e || !e.country || !e.event || !e.date) return false;
      if (majorOnly && !isMajor(e.event)) return false;
      if (!allowedCountries.includes(e.country)) return false;
      const d = parseUTC(e.date); if (!d) return false;
      const ts = d.getTime();
      return ts >= now && ts <= endTs && isHighOrMed(e.importance);
    }).sort((a,b) => new Date(a.date) - new Date(b.date))
      .slice(0, limit);

    // Cache preview for /econ_upcoming
    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: filtered }), { ex: 120 });

    // Send
    let sent = 0;
    for (const ev of filtered) {
      const when = parseUTC(ev.date);
      const whenLocal = when
        ? new Intl.DateTimeFormat('en-GB', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Dubai' }).format(when)
        : '—';
      const estimate = ev.forecast ? `\nForecast: ${ev.forecast}` : '';
      const previous = ev.previous ? `\nPrevious: ${ev.previous}` : '';
      const text =
`🔔 *${translateCountry(ev.country)} | ${ev.country}*
${ev.event}

⏰ ${whenLocal}${estimate}${previous}

💬 Reply to discuss this with the agent.`;
      const dedupeKey = `sent:${ev.country}:${ev.event}:${ev.date}`;
      if (await kv.get(dedupeKey)) continue;

      if (!dry) {
        for (const chat_id of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:'POST', headers:{ 'content-type':'application/json' },
            body: JSON.stringify({ chat_id: Number(chat_id), text, parse_mode:'Markdown', disable_notification:true })
          });
          sent++;
        }
      }
      await kv.set(dedupeKey, '1', { ex: 48*3600 });
    }

    return res.json({
      ok: true, source, subs: validSubs.length,
      events_total: events.length, events_after_filters: filtered.length,
      sent, windowMin, mode, countries: allowedCountries, limit, dry
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'unexpected', stack: e?.stack });
  }
}

function translateCountry(en) {
  const map = {'United States':'الولايات المتحدة','Euro Area':'منطقة اليورو','United Kingdom':'المملكة المتحدة','China':'الصين','Japan':'اليابان','Germany':'ألمانيا','France':'فرنسا','Canada':'كندا','Australia':'أستراليا','Switzerland':'سويسرا','India':'الهند','Brazil':'البرازيل','Mexico':'المكسيك','South Korea':'كوريا الجنوبية','Russia':'روسيا','US':'الولايات المتحدة','UK':'المملكة المتحدة'};
  return map[en] || en;
}
