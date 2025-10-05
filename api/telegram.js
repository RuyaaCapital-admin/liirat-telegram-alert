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
    await send(BOT_TOKEN, chat, '✅ تم الاشتراك في تنبيهات الأحداث الاقتصادية المهمة\n\n/econ_off لإلغاء الاشتراك\n/econ_test للتحقق من الحالة\n/econ_subs عدد المشتركين');
  }
  else if (text === '/econ_off') {
    await kv.del(`sub:${chat}`);
    await send(BOT_TOKEN, chat, '❌ تم إلغاء الاشتراك');
  }
  else if (text === '/econ_test') {
    await send(BOT_TOKEN, chat, '🟢 البوت نشط. الفحص كل 5 دقائق للأحداث المهمة');
  }
  else if (text === '/econ_subs') {
    const subKeys = await kv.keys('sub:*');
    const count = subKeys.length;
    const ids = subKeys.map(k => k.replace('sub:', '')).join('\n');
    await send(BOT_TOKEN, chat, `📊 عدد المشتركين: ${count}\n\n${ids || 'لا يوجد'}`);
  }
  else if (text === '/start' || text === 'hi' || text === 'telegram webhook') {
    await send(BOT_TOKEN, chat, '👋 مرحباً بك في تنبيهات liirat الاقتصادية\n\nالأوامر:\n/econ_on - اشترك\n/econ_off - إلغاء الاشتراك\n/econ_test - تحقق من الحالة\n/econ_subs - عدد المشتركين');
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
