import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    // ---------- Auth (Vercel Cron or your Bearer secret) ----------
    const auth = req.headers.authorization || '';
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    if (!(isVercelCron || auth === `Bearer ${process.env.CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ---------- Env ----------
    // Use liirat bot token; fall back to legacy TG_BOT_TOKEN if present.
    const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    const FMP_KEY   = process.env.FMP_API_KEY;
    if (!BOT_TOKEN || !FMP_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'missing env vars',
        has_bot_token: !!BOT_TOKEN,
        has_fmp_key: !!FMP_KEY
      });
    }

    // ---------- Subscribers ----------
    const subs = (await kv.smembers('econ:subs')) || [];
    const validSubs = subs.filter(id => /^\d+$/.test(String(id)));
    if (!validSubs.length) return res.json({ ok: true, sent: 0, reason: 'no valid subscribers' });

    // ---------- Query params ----------
    const { searchParams } = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const from = searchParams.get('from') || new Date().toISOString().slice(0, 10);
    const to   = searchParams.get('to')   || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const windowMin = Number(searchParams.get('minutes') || 15); // e.g. ?minutes=240
    const dry       = searchParams.get('dry') === '1';           // ?dry=1 to compute only

    // ---------- Fetch FMP (Node-safe timeout) ----------
    const api = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`;
    let events;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(api, { signal: controller.signal });
      clearTimeout(timer);

      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'fmp api error', status: r.status, response: await r.text() });
      }
      events = await r.json();
      if (!Array.isArray(events)) events = [];
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'api timeout or fetch error', message: String(e) });
    }

    // ---------- Filter window + high impact ----------
    const now = Date.now();
    const start = now - 5 * 60 * 1000;                 // allow late by 5 min
    const end   = now + windowMin * 60 * 1000;

    const highImpact = v => {
      const s = String(v ?? '').toLowerCase();
      return s === 'high' || s === '3' || s === 'high impact';
    };

    const parseUTC = s => {
      if (!s) return null;
      // FMP returns "YYYY-MM-DD HH:mm:ss" (no TZ) -> treat as UTC
      const d = new Date(String(s).replace(' ', 'T') + 'Z');
      return isFinite(d) ? d : null;
    };

    const upcoming = events.filter(e => {
      if (!highImpact(e.impact) && !highImpact(e.importance)) return false;
      const d = parseUTC(e.date || e.datetime || e.Date);
      if (!d) return false;
      const t = d.getTime();
      return t > start && t <= end;
    });

    // Cache for /econ_upcoming
    await kv.set('econ:cache:upcoming', JSON.stringify({ at: Date.now(), items: upcoming.slice(0, 50) }), { ex: 120 });

    // ---------- Send ----------
    let sent = 0;
    for (const ev of upcoming) {
      const when = parseUTC(ev.date || ev.datetime || ev.Date);
      const whenLocal = when ? fmtTime(when) : '—';
      const estimate = ev.estimate ? `\nEstimate | التوقع: ${ev.estimate}` : '';
      const previous = ev.previous ? `\nPrevious | السابق: ${ev.previous}` : '';
      const countryAr = translateCountry(ev.country);

      const text =
`🔔 *${countryAr} | ${ev.country}*
${ev.event}

⏰ ${whenLocal}${estimate}${previous}

💬 Reply to this message to ask the agent.`;

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
      subs: validSubs.length,
      events_total: events.length,
      events_window: upcoming.length,
      sent,
      windowMin,
      dry
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'unexpected', stack: error?.stack });
  }
}

function fmtTime(d) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai'
  }).format(d);
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
