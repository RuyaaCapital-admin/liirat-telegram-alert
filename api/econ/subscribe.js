import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { chat_id, username } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  
  // Reject template variables
  const chatIdStr = String(chat_id);
  if (chatIdStr.includes('{') || chatIdStr.includes('}') || chatIdStr.includes('user.')) {
    return res.status(400).json({ 
      error: 'Invalid chat_id - template variable not interpolated',
      received: chatIdStr,
      hint: 'Check Voiceflow variable syntax'
    });
  }
  
  // Validate it's a number
  if (!/^\d+$/.test(chatIdStr)) {
    return res.status(400).json({ 
      error: 'Invalid chat_id - must be numeric',
      received: chatIdStr
    });
  }
  
  await kv.sadd('econ:subs', chatIdStr);
  await kv.hset('econ:users', { [chatIdStr]: username || 'unknown' });
  
  const count = await kv.scard('econ:subs');
  return res.json({ ok: true, subscribers: count, chat_id: chatIdStr });
}