import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { chat_id, username } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  
  await kv.sadd('econ:subs', String(chat_id));
  await kv.hset('econ:users', { [chat_id]: username || 'unknown' });
  
  const count = await kv.scard('econ:subs');
  return res.json({ ok: true, subscribers: count });
}