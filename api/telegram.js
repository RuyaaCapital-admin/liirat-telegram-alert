// api/telegram.js
//
// Telegram webhook handler.  It handles a small set of slash commands:
//   /econ_test     – send a status message in both English and Arabic
//   /econ_upcoming – return a list of upcoming economic events from the
//                    cache built by cron.js (with a fallback to reading
//                    the schedule directly if the cache is empty)
//   /start         – show a welcome message with usage instructions
//
// The logic here mirrors api/econ/upcoming.js for building the event list.

import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Only process POST requests from Telegram; respond with a generic 200
  if (req.method !== 'POST') return new Response('ok');

  let update;
  try {
    const text = await req.text();
    update = JSON.parse(text);
  } catch {
    // Silently ignore parse errors
    return new Response('ok');
  }

  const msg = update?.message || update?.business_message;
  if (!msg?.chat?.id) return new Response('ok');

  const chat = String(msg.chat.id);
  const text = (msg.text || '').trim().toLowerCase();

  // Always use TG_BOT_TOKEN for bot‑to‑bot messages; alerts use LIIRAT_BOT_TOKEN
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;

  // Helper to send a Markdown message back to the user.  Disable notifications
  // on these interactive responses to avoid pinging users.
  async function send(token, chatId, message) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_notification: true
      })
    });
  }

  if (text === '/econ_test') {
    await send(
      BOT_TOKEN,
      chat,
      ' Alerts active | التنبيهات نشطة\n\nChannel: @liiratnews\nCheck interval: 5 min | الفحص كل 5 دقائق'
    );
    return new Response('ok');
  }
  else if (text === '/econ_upcoming') {
    // Fetch up to five upcoming events from the cache or schedule.  Use
    // bilingual formatting for consistency with the API.
    const limit = 5;
    try {
      let cache;
      try {
        const raw = await kv.get('econ:cache:upcoming');
        cache = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      } catch {
        cache = null;
      }
      let items = Array.isArray(cache?.items) ? cache.items : [];
      if (!items.length) {
        const now = Date.now();
        const end = now + 24 * 60 * 60 * 1000;
        let rawEvents = await kv.zrange('econ:manual', 0, -1);
        if (!rawEvents || !rawEvents.length) {
          rawEvents = await kv.zrange('econ:manual', 0, 99999);
        }
        if (!rawEvents || !rawEvents.length) {
          try {
            rawEvents = await kv.zrange('econ:manual', '-inf', '+inf', { byScore: true });
          } catch {
            // ignore errors
          }
        }
        const all = (rawEvents || [])
          .map(s => {
            try {
              const o = typeof s === 'string' ? JSON.parse(s) : s;
              o.ts = Date.parse(o.date);
              return Number.isFinite(o.ts) ? o : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .filter(e => e.ts >= now && e.ts <= end)
          .sort((a, b) => a.ts - b.ts);
        items = all;
      }
      items = items.slice(0, limit);

      // Build bilingual lines.  Keep translations in sync with cron.js
      const countryAr = {
        'United States': 'الولايات المتحدة',
        'Euro Area': 'منطقة اليورو',
        'United Kingdom': 'المملكة المتحدة',
        'Japan': 'اليابان',
        'China': 'الصين'
      };
      const fmtEn = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai'
      });
      const lines = items.map((ev, i) => {
        const when = fmtEn.format(new Date(ev.ts)) + ' (Asia/Dubai)';
        const countryEn = ev.country;
        const countryArName = countryAr[ev.country] || ev.country;
        const eventName = ev.event;
        const forecast = ev.forecast;
        const previous = ev.previous;
        const parts = [];
        parts.push(`${i + 1}. 🔔 ${countryArName}: ${eventName} | ${countryEn}: ${eventName}`);
        parts.push(`   ⏰ ${when}`);
        if (forecast) parts.push(`   التوقع: ${forecast} | Forecast: ${forecast}`);
        if (previous) parts.push(`   السابق: ${previous} | Previous: ${previous}`);
        return parts.join('\n');
      });
      const message =
        items.length
          ? `🔔 الأحداث الاقتصادية القادمة / Upcoming Economic Events\n\n${lines.join('\n\n')}`
          : 'لا توجد أحداث قادمة خلال الفترة المحددة.\nNo upcoming events in the selected window.';
      await send(BOT_TOKEN, chat, message);
    } catch {
      await send(BOT_TOKEN, chat, '❌ Could not fetch events | فشل جلب الأحداث');
    }
    return new Response('ok');
  }
  else if (text === '/start') {
    await send(
      BOT_TOKEN,
      chat,
      ' *Economic Calendar Alerts | تنبيهات التقويم الاقتصادي*\n\n Join channel for alerts:\nt.me/liiratnews\n\n*Commands | الأوامر:*\n/econ_upcoming - View events | عرض الأحداث\n/econ_test - Check status | التحقق من الحالة'
    );
    return new Response('ok');
  }
  // For any other message do nothing; Telegram will receive a 200 OK
  return new Response('ok');
}
