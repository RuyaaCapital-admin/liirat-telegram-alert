import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  
  const chatIdStr = String(chat_id);
  
  // Skip template variables silently (for cleanup)
  if (chatIdStr.includes('{') || chatIdStr.includes('}')) {
    await kv.srem('econ:subs', chatIdStr);
    await kv.hdel('econ:users', chatIdStr);
    return res.json({ ok: true, message: 'Template variable removed' });
  }
  
  await kv.srem('econ:subs', chatIdStr);
  await kv.hdel('econ:users', chatIdStr);
  
  const count = await kv.scard('econ:subs');
  return res.json({ ok: true, subscribers: count });
}