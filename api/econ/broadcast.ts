import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = process.env.LIIRAT_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'LIIRAT_BOT_TOKEN missing' });

  const subs = await kv.smembers('econ:subs');
  if (!subs?.length) return res.json({ ok: true, sent: 0, reason: 'no subscribers' });

  const text = req.query.text || '🔔 test broadcast';
  let sent = 0;
  for (const id of subs) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(id), text, parse_mode: 'Markdown' })
    });
    sent++;
  }
  return res.json({ ok: true, subs: subs.length, sent });
}
