import { kv } from '@vercel/kv';

export const config = { 
  runtime: 'edge',
  maxDuration: 60
};

export default async function handler(req) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  
  // Using Trading Economics guest key (free, may be rate-limited)
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  
  const url = `https://api.tradingeconomics.com/calendar/country/All/${today}/${tomorrow}?c=guest:guest&importance=3&f=json`;
  
  let events;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return new Response('api error', { status: 500 });
    events = await res.json();
  } catch (e) {
    return new Response('api timeout', { status: 500 });
  }
  
  const subKeys = await kv.keys('sub:*');
  const subs = subKeys.map(k => k.replace('sub:', ''));
  if (!subs.length) return new Response('no subs');

  const now = new Date();
  const LEAD_MS = 15 * 60 * 1000;
  let sent = 0;

  for (const e of events) {
    const imp = String(e.Importance ?? '3');
    if (imp !== '3') continue;

    const when = new Date(e.Date + 'Z');
    const msTo = when - now;

    if (msTo > LEAD_MS || msTo < -5 * 60 * 1000) continue;

    const id = e.CalendarId ?? `${e.Country}-${e.Event}-${e.Date}`;
    const dedupeKey = `sent:${id}`;
    const already = await kv.get(dedupeKey);
    if (already) continue;

    const text = `🔔 *${e.Country}: ${e.Event}* (High)\nWhen: ${fmtTime(when)}\n${e.Forecast ? `Forecast: ${e.Forecast}` : ''}${e.Previous ? `\nPrev: ${e.Previous}` : ''}`;
    
    for (const chat of subs) {
      await send(BOT_TOKEN, chat, text);
    }

    await kv.set(dedupeKey, '1', { ex: 172800 });
    sent++;
  }

  return new Response(`ok - sent ${sent} alerts`);
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
