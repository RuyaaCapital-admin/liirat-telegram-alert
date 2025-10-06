import { kv } from '@vercel/kv';

export default async function handler(req, res){
  const cached = await kv.get('econ:cache:upcoming');
  const data = cached ? JSON.parse(cached) : { items: [] };
  const items = (data.items || []).slice(0, 5);

  const lines = items.map((e,i)=>{
    const when = new Date(Date.parse((e.date||e.datetime||e.Date)+'Z'))
      .toLocaleString('en-GB',{hour:'2-digit',minute:'2-digit'});
    return `${i+1}. *${e.country}*: ${e.event}\n   ${when}`;
  });

  res.json({
    ok:true,
    text: lines.length ? `📅 *Upcoming High-Impact*\n\n${lines.join('\n\n')}` : 'No high-impact events soon.'
  });
}
