'use strict';
const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const out = { ok: true };
    out.kv_url_prefix = (process.env.KV_REST_API_URL || '').slice(0, 40) + '...';

    // What do we have in econ:manual?
    out.zcard_manual   = await kv.zcard('econ:manual').catch(e => `ERR: ${e.message}`);
    out.zrange_first3  = await kv.zrange('econ:manual', 0, 2, { withScores: true })
                                .catch(e => `ERR: ${e.message}`);
    // If someone accidentally wrote a string instead of ZSET:
    out.get_string     = await kv.get('econ:manual').catch(e => `ERR: ${e.message}`);

    // Subscribers sanity
    out.subs           = await kv.smembers('econ:subs').catch(e => `ERR: ${e.message}`);
    out.subs_count     = Array.isArray(out.subs) ? out.subs.length : 'N/A';

    // Upcoming cache (for visibility)
    out.cache_upcoming = await kv.get('econ:cache:upcoming').catch(e => `ERR: ${e.message}`);

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
};
