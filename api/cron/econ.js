import { kv } from '@vercel/kv';

export const config = { 
  runtime: 'edge',
  maxDuration: 60
};

const BOT_TOKEN = '8221876903:AAFdO5JtS0E4B4N5MNZ68FPo6LIzletcdME';

export default async function handler(req) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  // Get subscribers
  const subs = await kv.smembers('econ:subs') || [];
  if (!subs.length) {
    return new Response(JSON.stringify({ sent: 0, message: 'No subscribers' }), {
      headers: { 'content-type': 'application/json' }
    });
  }
  
  // Fetch upcoming high-impact events (next 30 min)
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 60000);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  
  const url = `https://api.tradingeconomics.com/calendar/country/All/${today}/${tomorrow}?c=guest:guest&importance=3&f=json`;
  
  let events;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return new Response('API error', { status: 500 });
    }
    events = await res.json();
  } catch (e) {
    return new Response('API timeout', { status: 500 });
  }

  // Filter for upcoming events in next 30 min
  const upcoming = events.filter(e => {
    const eventTime = new Date(e.Date + 'Z');
    return eventTime > now && eventTime <= future && String(e.Importance ?? '3') === '3';
  });
  
  if (!upcoming.length) {
    return new Response(JSON.stringify({ sent: 0, message: 'No upcoming events' }), {
      headers: { 'content-type': 'application/json' }
    });
  }

  // Send alerts to all subscribers
  let sent = 0;
  for (const chat_id of subs) {
    for (const ev of upcoming) {
      // Check dedupe
      const dedupeKey = `sent:${chat_id}:${ev.CalendarId || `${ev.Country}-${ev.Event}-${ev.Date}`}`;
      const already = await kv.get(dedupeKey);
      if (already) continue;

      const when = new Date(ev.Date + 'Z').toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Dubai'
      });
      
      const forecast = ev.Forecast ? `\n📊 Forecast: ${ev.Forecast}` : '';
      const previous = ev.Previous ? `\n📈 Previous: ${ev.Previous}` : '';
      
      const msg = `🔔 *High-Impact Event*\n\n🌍 *${ev.Country}*\n📊 ${ev.Event}\n⏰ ${when} Dubai time${forecast}${previous}\n\n💬 _Reply to this message to ask the agent about it._`;
      
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(chat_id),
          text: msg,
          parse_mode: 'Markdown',
          disable_notification: false
        })
      });
      
      // Mark as sent (expire in 2 days)
      await kv.set(dedupeKey, '1', { ex: 172800 });
      sent++;
    }
  }
  
  return new Response(JSON.stringify({ sent, subs: subs.length, events: upcoming.length }), {
    headers: { 'content-type': 'application/json' }
  });
}