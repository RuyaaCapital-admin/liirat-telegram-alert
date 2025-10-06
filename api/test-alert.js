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
  
  // Get subscribers
  const subscribers = await kv.smembers('econ:subs') || [];
  const validSubs = subscribers.filter(id => {
    const idStr = String(id);
    return !idStr.includes('{') && !idStr.includes('}') && /^\d+$/.test(idStr);
  });
  
  if (!validSubs.length) {
    return new Response('ok - no valid subscribers', { status: 200 });
  }

  // Test alert message
  const text = `🔔 *Test Alert | تنبيه تجريبي*
Economic Calendar System Active

⏰ Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })}

✅ Subscription confirmed
✅ You'll receive High impact economic events 15 min before release

Countries monitored:
🇺🇸 United States | الولايات المتحدة
🇪🇺 Euro Area | منطقة اليورو  
🇬🇧 United Kingdom | المملكة المتحدة
🇨🇳 China | الصين
🇯🇵 Japan | اليابان

Type /econ_off to unsubscribe`;

  // Send to all valid subscribers
  for (const chat_id of validSubs) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chat_id, 
        text: text, 
        parse_mode: 'Markdown',
        disable_notification: true 
      })
    });
  }

  return new Response(`ok - sent test to ${validSubs.length} users`);
}