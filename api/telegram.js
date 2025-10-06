import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('ok');
  
  let update;
  try {
    const text = await req.text();
    update = JSON.parse(text);
  } catch (e) {
    return new Response('ok');
  }
  
  const msg = update?.message || update?.business_message;
  if (!msg?.chat?.id) return new Response('ok');

  const chat = String(msg.chat.id);
  const text = (msg.text || '').trim().toLowerCase();

  const BOT_TOKEN = process.env.TG_BOT_TOKEN;

  if (text === '/econ_test') {
    await send(BOT_TOKEN, chat, '🟢 Alerts active | التنبيهات نشطة\n\nChannel: @liiratnews\nCheck interval: 5 min | الفحص كل 5 دقائق');
  }
  else if (text === '/econ_upcoming') {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const url = `https://api.tradingeconomics.com/calendar/country/All/${today}/${future}?c=guest:guest&importance=3&f=json`;
    
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const events = await res.json();
      
      if (!events?.length) {
        await send(BOT_TOKEN, chat, '📅 No high-impact events in next 7 days\nلا توجد أحداث مهمة في الأيام السبعة القادمة');
        return new Response('ok');
      }

      const lines = ['📅 *Upcoming High-Impact Events | الأحداث الاقتصادية المهمة القادمة*\n'];
      events.slice(0, 15).forEach((e, i) => {
        const when = new Date(e.Date + 'Z');
        const date = when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Dubai' });
        const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });
        const forecast = e.Forecast ? ` | Est: ${e.Forecast}` : '';
        lines.push(`${i + 1}. *${e.Country}*: ${e.Event}${forecast}\n   📍 ${date} at ${time}\n`);
      });

      if (events.length > 15) lines.push(`\n_+${events.length - 15} more events | المزيد من الأحداث_`);
      
      await send(BOT_TOKEN, chat, lines.join('\n'));
    } catch (e) {
      await send(BOT_TOKEN, chat, '❌ Could not fetch events | فشل جلب الأحداث');
    }
  }
  else if (text === '/start') {
    await send(BOT_TOKEN, chat, '📊 *Economic Calendar Alerts | تنبيهات التقويم الاقتصادي*\n\n📢 Join channel for alerts:\nt.me/liiratnews\n\n*Commands | الأوامر:*\n/econ_upcoming - View events | عرض الأحداث\n/econ_test - Check status | التحقق من الحالة');
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
