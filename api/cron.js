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
  const FMP_KEY = process.env.FMP_API_KEY;
  
  // Get ALL subscribers from KV
  const subscribers = await kv.smembers('econ:subs') || [];
  
  // Filter out invalid chat_ids (template variables, non-numeric)
  const validSubs = subscribers.filter(id => {
    const idStr = String(id);
    return !idStr.includes('{') && !idStr.includes('}') && /^\d+$/.test(idStr);
  });
  
  if (!validSubs.length) {
    return new Response('ok - no valid subscribers', { status: 200 });
  }
  
  // FMP API - Economic Calendar
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  
  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${today}&to=${tomorrow}&apikey=${FMP_KEY}`;
  
  let events;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return new Response('fmp api error', { status: 500 });
    events = await res.json();
  } catch (e) {
    return new Response('api timeout', { status: 500 });
  }

  const now = new Date();
  const LEAD_MS = 15 * 60 * 1000; // 15 minutes
  let sent = 0;

  for (const e of events) {
    // FMP uses impact: "High", "Medium", "Low"
    if (e.impact !== 'High') continue;

    const when = new Date(e.date);
    const msTo = when - now;

    if (msTo > LEAD_MS || msTo < -5 * 60 * 1000) continue;

    const id = `${e.country}-${e.event}-${e.date}`;
    const dedupeKey = `sent:${id}`;
    const already = await kv.get(dedupeKey);
    if (already) continue;

    const country = translateCountry(e.country);
    const whenLocal = fmtTime(when);
    const estimate = e.estimate ? `\nEstimate | التوقع: ${e.estimate}` : '';
    const previous = e.previous ? `\nPrevious | السابق: ${e.previous}` : '';

    // Bilingual alert
    const text = `🔔 *${country} | ${e.country}*\n${e.event}\n\n⏰ ${whenLocal}${estimate}${previous}`;
    
    // Send to ALL valid subscribers
    for (const chat_id of validSubs) {
      await send(BOT_TOKEN, chat_id, text);
    }

    await kv.set(dedupeKey, '1', { ex: 172800 });
    sent++;
  }

  return new Response(`ok - sent ${sent} events to ${validSubs.length} users (${subscribers.length - validSubs.length} invalid skipped)`);
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