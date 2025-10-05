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

  if (text === '/econ_on') {
    await kv.set(`sub:${chat}`, '1');
    await send(BOT_TOKEN, chat, '✅ Subscribed to high-impact econ alerts.\n\n/econ_off to stop\n/econ_test to check status');
  }
  else if (text === '/econ_off') {
    await kv.del(`sub:${chat}`);
    await send(BOT_TOKEN, chat, '❌ Unsubscribed from alerts.');
  }
  else if (text === '/econ_test') {
    await send(BOT_TOKEN, chat, '🟢 Alerts bot active. Cron checks every 5 min for high-impact events.');
  }
  else if (text === '/start' || text === 'hi' || text === 'telegram webhook') {
    await send(BOT_TOKEN, chat, '👋 Welcome to liirat Economic Alerts!\n\nCommands:\n/econ_on - Subscribe\n/econ_off - Unsubscribe\n/econ_test - Check status');
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
      disable_notification: true 
    })
  });
}
