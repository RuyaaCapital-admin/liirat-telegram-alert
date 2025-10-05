import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Verify Vercel Cron secret
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const FMP_KEY = process.env.FMP_API_KEY;
  
  // Fetch FMP calendar (today + tomorrow)
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  
  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${today}&to=${tomorrow}&apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return new Response('fmp error', { status: 500 });
  
  const events = await res.json();
  
  // Get subscribers
  const subKeys = await kv.keys('sub:*');
  const subs = subKeys.map(k => k.replace('sub:', ''));
  if (!subs.length) return new Response('no subs');

  const now = new Date();
  const LEAD_MS = 15 * 60 * 1000; // 15 min

  for (const e of events) {
    // FMP fields: date, country, event, impact (Low/Medium/High), actual, estimate, previous
    if (e.impact !== 'High') continue;

    const when = new Date(e.date); // FMP gives ISO string
    const msTo = when - now;

    // Alert if within 15 min window, not already sent
    if (msTo > LEAD_MS || msTo < -5 * 60 * 1000) continue;

    const dedupeKey = `sent:${e.country}:${e.event}:${e.date}`;
    const already = await kv.get(dedupeKey);
    if (already) continue;

    const text = `🔔 *${e.country}: ${e.event}* (High)\nWhen: ${fmtTime(when)}\n${e.estimate ? `Est: ${e.estimate}` : ''}${e.previous ? `\nPrev: ${e.previous}` : ''}`;
    
    // Broadcast
    for (const chat of subs) {
      await send(BOT_TOKEN, chat, text);
    }

    // Mark sent (48h TTL)
    await kv.set(dedupeKey, '1', { ex: 172800 });
  }

  return new Response('ok');
}

async function send(token, chat, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 
      chat_id: chat, 
      text, 
      parse_mode: 'Markdown',
      disable_notification: true 
    })
  });
}

function fmtTime(d) {
  return new Intl.DateTimeFormat('en-GB', { 
    dateStyle: 'medium', 
    timeStyle: 'short', 
    timeZone: 'Asia/Dubai' 
  }).format(d);
}
