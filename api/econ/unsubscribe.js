import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  
  await kv.srem('econ:subs', String(chat_id));
  await kv.hdel('econ:users', String(chat_id));
  
  const count = await kv.scard('econ:subs');
  return res.json({ ok: true, subscribers: count });
}