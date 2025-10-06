import { kv } from '@vercel/kv';

export const config = { 
  runtime: 'edge',
  maxDuration: 60
};

const BOT_TOKEN = process.env.LIIRAT_BOT_TOKEN;
const FMP_API_KEY = process.env.FMP_API_KEY;

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
  
  // Fetch upcoming high-impact events from FMP
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 60000);
  
  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?apikey=${FMP_API_KEY}`;
  
  let events;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error('FMP API error:', res.status);
      return new Response(JSON.stringify({ error: 'API error', status: res.status }), { status: 500 });
    }
    events = await res.json();
  } catch (e) {
    console.error('FMP fetch failed:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }

  // Filter for upcoming events in next 30 min with high impact
  const upcoming = events.filter(e => {
    const eventTime = new Date(e.date);
    const impact = (e.impact || '').toLowerCase();
    return eventTime > now && eventTime <= future && impact === 'high';
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
      const dedupeKey = `sent:${chat_id}:${ev.date}-${ev.event}`;
      const already = await kv.get(dedupeKey);
      if (already) continue;

      const when = new Date(ev.date).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Dubai'
      });
      
      const estimate = ev.estimate ? `\n📊 Estimate: ${ev.estimate}` : '';
      const previous = ev.previous ? `\n📈 Previous: ${ev.previous}` : '';
      
      const msg = `🔔 *High-Impact Event*\n\n🌍 *${ev.country}*\n📊 ${ev.event}\n⏰ ${when} Dubai time${estimate}${previous}\n\n💬 _Reply to this message to ask the agent about it._`;
      
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
