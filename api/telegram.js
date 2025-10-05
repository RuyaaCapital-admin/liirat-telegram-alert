
import { kv } from '@vercel/kv';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('ok');
  
  const update = await req.json().catch(() => null);
  const msg = update?.message || update?.business_message;
  if (!msg?.chat?.id) return new Response('ok');

  const chat = String(msg.chat.id);
  const text = (msg.text || '').trim().toLowerCase();

  const BOT_TOKEN = process.env.TG_BOT_TOKEN;

  if (text === '/econ_on') {
    await kv.set(`sub:${chat}`, '1');
    await send(BOT_TOKEN, chat, '✅ Subscribed to high-impact econ alerts.\n\n/econ_off to stop\n/econ_test to check status');
  }
  if (text === '/econ_off') {
    await kv.del(`sub:${chat}`);
    await send(BOT_TOKEN, chat, '❌ Unsubscribed.');
  }
  if (text === '/econ_test') {
    await send(BOT_TOKEN, chat, '🟢 Alerts active. Next check in <5 min.');
  }

  return new Response('ok');
}

async function send(token, chat, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_notification: true })
  });
}
