import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!(isCron || auth === `Bearer ${process.env.CRON_SECRET}`))
      return res.status(401).json({ ok:false, error:'unauthorized' });

    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ ok:false, error:'LIIRAT_BOT_TOKEN missing' });

    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(id => /^\d+$/.test(String(id)));
    if (!validSubs.length) return res.json({ ok:true, sent:0, reason:'no valid subscribers' });

    const { searchParams } = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const from = searchParams.get('from') || new Date().toISOString().slice(0,10);
    const to   = searchParams.get('to')   || new Date(Date.now()+86400000).toISOString().slice(0,10);
    const windowMin = Number(searchParams.get('minutes') || 15);
    const dry       = searchParams.get('dry') === '1';

    // -------- fetch events (try FMP, fallback to TradingEconomics) --------
    let events = [];
    let source = 'fmp';
    const FMP_KEY = process.env.FMP_API_KEY;

    if (FMP_KEY) {
      const apiFmp = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`;
      try {
        const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 8000);
        const r = await fetch(apiFmp, { signal: ac.signal });
        clearTimeout(t);
        if (r.ok) {
          const raw = await r.json();
          if (Array.isArray(raw)) {
            events = raw.map(e => ({
              country: e.country, event: e.event, date: e.date,
              estimate: e.estimate, previous: e.previous,
              impact: e.impact || e.importance
            }));
          }
        } else if (r.status !== 404) {
          source = 'te'; // 403/other => fallback
        }
      } catch { source = 'te'; }
    } else {
      source = 'te';
    }

    if (source === 'te') {
      const teKey = process.env.TE_API_KEY || 'guest:guest';
      const apiTe = `https://api.tradingeconomics.com/calendar?importance=3&c=${encodeURIComponent(teKey)}&f=json`;
      const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 8000);
      const r = await fetch(apiTe, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) {
        return res.status(502).json({ ok:false, error:'te api error', status:r.status, response: await r.text() });
      }
      const raw = await r.json();
      events = (Array.isArray(raw) ? raw : []).map(e => ({
        country: e.Country, event: e.Event, date: e.Date, // TE returns ISO or UTC string
        estimate: e.Forecast, previous: e.Previous,
        impact: e.Importance || e.Impact || '3' // TE high=3
      }));
    }

    // -------- filter window + high impact --------
    const now = Date.now(), start = now - 5*60*1000, end = now + windowMin*60*1000;
    const hi = v => {
      const s = String(v ?? '').toLowerCase();
      return s === 'high' || s === '3' || s === 'high impact';
    };

    const parseUTC = s => {
      if (!s) return null;
      let d = new Date(s);
      if (!isFinite(d)) d = new Date(String(s).replace(' ', 'T') + 'Z');
      return isFinite(d) ? d : null;
    };

    const upcoming = events.filter(e => {
      if (!hi(e.impact)) return false;
      const d = parseUTC(e.date);
      if (!d) return false;
      const t = d.getTime();
      return t > start && t <= end;
    });

    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: upcoming.slice(0,50) }), { ex: 120 });

    // -------- send --------
    let sent = 0;
    for (const ev of upcoming) {
      const when = parseUTC(ev.date);
      const whenLocal = when
        ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Dubai'}).format(when)
        : '—';
      const estimate = ev.estimate ? `\nEstimate | التوقع: ${ev.estimate}` : '';
      const previous = ev.previous ? `\nPrevious | السابق: ${ev.previous}` : '';

      const text =
`🔔 *${translateCountry(ev.country)} | ${ev.country}*
${ev.event}

⏰ ${whenLocal}${estimate}${previous}

💬 Reply to this message to ask the agent.`;

      const dedupeKey = `sent:${ev.country}:${ev.event}:${ev.date}`;
      if (await kv.get(dedupeKey)) continue;

      if (!dry) {
        for (const chat_id of validSubs) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({ chat_id: Number(chat_id), text, parse_mode:'Markdown', disable_notification:true })
          });
          sent++;
        }
      }
      await kv.set(dedupeKey, '1', { ex: 48*3600 });
    }

    return res.json({
      ok:true, source, subs: validSubs.length,
      events_total: events.length, events_window: upcoming.length,
      sent, windowMin, dry
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'unexpected', stack: e?.stack });
  }
}

function translateCountry(en) {
  const map = { 'United States':'الولايات المتحدة','Euro Area':'منطقة اليورو','United Kingdom':'المملكة المتحدة','China':'الصين','Japan':'اليابان','Germany':'ألمانيا','France':'فرنسا','Canada':'كندا','Australia':'أستراليا','Switzerland':'سويسرا','India':'الهند','Brazil':'البرازيل','Mexico':'المكسيك','South Korea':'كوريا الجنوبية','Russia':'روسيا','US':'الولايات المتحدة','UK':'المملكة المتحدة' };
  return map[en] || en;
}
