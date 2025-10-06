import { kv } from '@vercel/kv';

export const config = { 
  runtime: 'edge'
};

export default async function handler(req) {
  // Optional auth - remove in production or add proper secret
  const secret = req.headers.get('authorization');
  if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }

  // Get all subscribers
  const subs = await kv.smembers('econ:subs') || [];
  
  let cleaned = 0;
  let valid = 0;
  
  for (const chat_id of subs) {
    const chatIdStr = String(chat_id);
    
    // Remove template variables and non-numeric entries
    if (chatIdStr.includes('{') || chatIdStr.includes('}') || !/^\d+$/.test(chatIdStr)) {
      await kv.srem('econ:subs', chatIdStr);
      await kv.hdel('econ:users', chatIdStr);
      cleaned++;
    } else {
      valid++;
    }
  }
  
  return new Response(JSON.stringify({
    ok: true,
    cleaned,
    valid,
    message: `Removed ${cleaned} invalid entries, ${valid} valid remain`
  }), {
    headers: { 'content-type': 'application/json' }
  });
}