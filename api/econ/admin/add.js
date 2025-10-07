const { kv } = require('@vercel/kv');

// POST one or many events to KV manual schedule.
// Auth: Authorization: Bearer <CRON_SECRET>
// Body: { events: [{ country, event, date, forecast?, previous? }, ...] }
// date = ISO string (UTC), e.g. "2025-10-08T13:30:00Z"

module.exports = async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  
  const auth = req.headers.authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  
  console.log('[ADD] Auth header:', auth ? 'present' : 'missing');
  console.log('[ADD] Expected:', expectedAuth ? 'configured' : 'missing');
  
  if (auth !== expectedAuth) {
    console.error('[ADD] Auth failed:', { received: auth, expected: expectedAuth });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let payload;
  try {
    payload = req.body || {};
  } catch (err) {
    console.error('[ADD] JSON parse error:', err.message);
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  
  const arr = Array.isArray(payload.events) ? payload.events : [];
  console.log('[ADD] Received events:', arr.length);

  const toAdd = [];
  for (const ev of arr) {
    if (!ev || !ev.country || !ev.event || !ev.date) {
      console.log('[ADD] Skipping invalid event:', ev);
      continue;
    }
    const ts = Date.parse(ev.date);
    if (!Number.isFinite(ts)) {
      console.log('[ADD] Invalid date:', ev.date);
      continue;
    }
    const clean = {
      country: String(ev.country),
      event: String(ev.event),
      date: new Date(ts).toISOString(),
      forecast: ev.forecast ?? null,
      previous: ev.previous ?? null
    };
    toAdd.push({ score: ts, member: JSON.stringify(clean) });
    console.log('[ADD] Valid event:', clean.country, clean.event, clean.date);
  }

  if (!toAdd.length) {
    console.error('[ADD] No valid events to add');
    return res.status(400).json({ ok: false, error: 'no_valid_events' });
  }

  try {
    // Keep only next 90 days to avoid bloat
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    await kv.zremrangebyscore('econ:manual', 0, cutoff);
    
    const added = await kv.zadd('econ:manual', ...toAdd);
    console.log('[ADD] Successfully added:', added, 'events');
    
    return res.json({ ok: true, added, count: toAdd.length });
  } catch (err) {
    console.error('[ADD] KV error:', err.message);
    return res.status(500).json({ ok: false, error: 'kv_error', details: err.message });
  }
};
