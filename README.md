# Liirat Economic Alerts

🔔 **Real-time economic calendar alerts for Telegram**

Delivers high-impact macro event alerts (CPI, NFP, rate decisions) directly to users via DM, integrated with Voiceflow agent.

---

## 🚀 Features

✅ **Live Data Sources**
- Finnhub economic calendar (free tier, 60 calls/min)
- FMP fallback provider
- Manual event overrides

✅ **Auto-Triggered Alerts**
- Cron runs every 5 minutes
- Sends alerts 5-60 min before events
- No manual triggers needed

✅ **Smart Filtering**
- Countries: US, Euro Area, UK, Germany, Japan, China
- Major keywords: CPI, NFP, FOMC, GDP, PMI, unemployment, etc.
- Bilingual format (Arabic + English)

✅ **Deduplication**
- Per-event dedupe keys (48h TTL)
- Prevents duplicate alerts across cron runs

✅ **Voiceflow Integration**
- `/econ_on` - Subscribe to alerts
- `/econ_off` - Unsubscribe
- `/econ_upcoming` - View next events

---

## 📋 Setup

### 1. Environment Variables (Vercel)

```bash
# Required
LIIRAT_BOT_TOKEN=your_telegram_bot_token
CRON_SECRET=random_secret_string
KV_REST_API_URL=https://your-upstash-kv.io
KV_REST_API_TOKEN=your_kv_token

# At least one provider required
FINNHUB_API_KEY=your_finnhub_key  # Recommended (free tier)
FMP_API_KEY=your_fmp_key          # Optional fallback
```

### 2. Vercel KV Setup

1. Create Vercel KV store in dashboard
2. Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN`
3. Add to environment variables

### 3. Telegram Bot Setup

1. Create bot via @BotFather
2. Copy token → `LIIRAT_BOT_TOKEN`
3. Set webhook (handled by Voiceflow)

### 4. Provider Keys

**Finnhub (recommended):**
- Sign up: https://finnhub.io
- Free tier: 60 calls/min, includes economic calendar
- Copy API key → `FINNHUB_API_KEY`

**FMP (optional):**
- Sign up: https://financialmodelingprep.com
- Free tier limited, may require paid plan
- Copy API key → `FMP_API_KEY`

---

## 🔄 How It Works

### Auto-Alert Flow:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User sends /econ_on → Added to econ:subs (Redis)        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Vercel Cron runs /api/cron every 5 minutes              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Fetch events 5-60 min away from Finnhub/FMP             │
│    + Merge manual events from econ:manual (Redis)           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Filter by country + keywords (mode=major)                │
│    Countries: US, EA, UK, DE, JP, CN                        │
│    Keywords: CPI, NFP, FOMC, GDP, PMI, rate, etc.           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Check dedupe: econ:sent:<country>|<event>|<ISO-minute>  │
│    Skip if already sent (48h TTL)                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Send bilingual DM to all econ:subs chat IDs             │
│    Format: 🔔 Country: Event | ⏰ Time (Dubai)              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 7. User receives alert, can reply → Agent responds         │
└─────────────────────────────────────────────────────────────┘
```

### Caching:
- Alert window: 5-60 min (for sending DMs)
- Cache window: 24h (for `/econ_upcoming` endpoint)
- Cache key: `econ:cache:upcoming` (TTL: 5 min)

---

## 🛠️ API Endpoints

### `/api/cron` (Authenticated)
Scheduled job that fetches events and sends alerts.

**Auth:** `Authorization: Bearer <CRON_SECRET>`

**Query params:**
```bash
?minutes=60        # Alert window (default: 60)
?days=1            # Alternative (1 day = 1440 min)
?mode=major        # Filter major events (default)
?mode=all          # No filtering
?limit=10          # Max events (default: 10)
?lang=both         # Bilingual (default)
?lang=en           # English only
?lang=ar           # Arabic only
?dry=1             # Test mode (no DMs)
?source=manual     # Force manual events only
```

**Example:**
```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?minutes=120&mode=major&limit=5&dry=1"
```

### `/api/econ/subscribe` (POST)
Add user to alert subscribers.

**Body:**
```json
{"chat_id": "123456789", "username": "john"}
```

### `/api/econ/unsubscribe` (POST)
Remove user from subscribers.

**Body:**
```json
{"chat_id": "123456789"}
```

### `/api/econ/upcoming` (Public)
Get cached upcoming events (for Voiceflow).

**Query params:**
```bash
?limit=5           # Max events (default: 5)
?lang=bi           # Bilingual (default: bi)
```

**Response:**
```json
{
  "ok": true,
  "count": 5,
  "items": [{"country": "United States", "event": "CPI y/y", "date": "2025-10-08T13:30:00Z"}],
  "text": "🔔 الأحداث الاقتصادية القادمة / Upcoming Economic Events\n\n1. *United States / الولايات المتحدة*: Core CPI y/y..."
}
```

### `/api/econ/admin/add` (POST, Authenticated)
Manually add test events.

**Auth:** `Authorization: Bearer <CRON_SECRET>`

**Body:**
```json
{
  "events": [
    {
      "country": "United States",
      "event": "Test CPI",
      "date": "2025-10-08T13:30:00Z",
      "forecast": "0.3%",
      "previous": "0.2%"
    }
  ]
}
```

---

## 📊 Redis Keys

**Subscribers:**
- `econ:subs` (SET) - Chat IDs of subscribed users
- `econ:users` (HASH) - Chat ID → username mapping

**Events:**
- `econ:manual` (ZSET) - Manual test events (score = timestamp)
- `econ:cache:upcoming` (STRING) - Cached events JSON (TTL: 5 min)

**Deduplication:**
- `econ:sent:<country>|<event>|<ISO-minute>` (STRING) - Sent markers (TTL: 48h)

---

## 🧪 Testing

See [DEPLOYMENT.md](DEPLOYMENT.md) for comprehensive testing guide.

**Quick tests:**

```bash
# 1. Dry run (no DMs)
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?days=7&dry=1"

# 2. Check upcoming cache
curl "https://your-domain.vercel.app/api/econ/upcoming?limit=5&lang=bi"

# 3. Subscribe test user
curl -X POST "https://your-domain.vercel.app/api/econ/subscribe" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"123456789","username":"test"}'

# 4. Real alert test (sends DMs)
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?minutes=120&mode=major&limit=3"
```

---

## 🐛 Troubleshooting

### No events showing?
1. Check provider keys are set in Vercel
2. Test provider directly:
   ```bash
   curl "https://finnhub.io/api/v1/calendar/economic?from=2025-10-07&to=2025-10-14&token=$FINNHUB_API_KEY"
   ```
3. Force dry run to see what's fetched:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://your-domain.vercel.app/api/cron?days=7&mode=all&limit=20&dry=1"
   ```

### Alerts not sending?
1. Check subscribers exist: `SMEMBERS econ:subs` in Redis
2. Verify bot token: `curl https://api.telegram.org/bot$LIIRAT_BOT_TOKEN/getMe`
3. Check dedupe keys: `KEYS econ:sent:*` in Redis

### Duplicate alerts?
- Dedupe should prevent this
- Check Redis TTL: `TTL econ:sent:<key>`
- Verify cron secret is same across environments

---

## 📝 License

MIT License - see [LICENSE](LICENSE)

---

## 🔗 Links

- [Deployment Guide](DEPLOYMENT.md)
- [Finnhub API Docs](https://finnhub.io/docs/api/economic-calendar)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Upstash Redis](https://upstash.com/docs/redis)
