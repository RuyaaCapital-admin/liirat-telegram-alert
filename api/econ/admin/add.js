import { kv } from '@vercel/kv';

// POST one or many events to KV manual schedule.
// Auth: Authorization: Bearer <CRON_SECRET>
// Body: { events: [{ country, event, date, forecast?, previous? }, ...] }
// date = ISO string (UTC), e.g. "2025-10-08T13:30:00Z"

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'unauthorized' });

  let payload;
  try { payload = req.body || {}; } catch { return res.status(400).json({ ok:false, error:'invalid_json' }); }
  const arr = Array.isArray(payload.events) ? payload.events : [];

  const toAdd = [];
  for (const ev of arr) {
    if (!ev || !ev.country || !ev.event || !ev.date) continue;
    const ts = Date.parse(ev.date);
    if (!Number.isFinite(ts)) continue;
    const clean = {
      country: String(ev.country),
      event: String(ev.event),
      date: new Date(ts).toISOString(),
      forecast: ev.forecast ?? null,
      previous: ev.previous ?? null
    };
    toAdd.push({ score: ts, member: JSON.stringify(clean) });
  }

  if (!toAdd.length) return res.status(400).json({ ok:false, error:'no_valid_events' });

  // Keep only next 90 days to avoid bloat
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  await kv.zremrangebyscore('econ:manual', 0, cutoff);
  const added = await kv.zadd('econ:manual', ...toAdd);

  return res.json({ ok:true, added, count: toAdd.length });
}
