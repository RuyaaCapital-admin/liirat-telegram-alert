# Deployment & Verification Guide

## What Changed

### ✅ Live Data Providers
- **Finnhub** (primary): Real economic calendar with 60 calls/min on free tier
- **FMP** (fallback): Backup if Finnhub fails
- **Manual events**: Override layer via `/api/econ/admin/add`

### ✅ Auto-Trigger Alerts
- Cron runs every **5 minutes** (was 15)
- Sends alerts **5-60 minutes before events**
- Users get auto-alerts when events trigger (no manual action needed)

### ✅ Country Normalization
- Maps codes → full names: US → United States, EA/EU → Euro Area, GB/UK → United Kingdom
- Filters: United States, Euro Area, United Kingdom, Japan, China, Germany

### ✅ Smart Caching
- Alert window: 5-60 min (immediate alerts)
- Cache window: 24h (for `/econ_upcoming` endpoint)
- TTL: 5 minutes (refreshed on each cron run)

---

## Required Environment Variables

In **Vercel → Settings → Environment Variables**, ensure these exist:

```bash
# Bot (required)
LIIRAT_BOT_TOKEN=7995***  # or TG_BOT_TOKEN

# Auth (required)
CRON_SECRET=your_secret

# Upstash KV (required)
KV_REST_API_URL=https://***
KV_REST_API_TOKEN=***

# Providers (at least one required)
FINNHUB_API_KEY=***  # Primary (free tier works)
FMP_API_KEY=***       # Fallback (optional)
```

---

## Verification Steps

### 1. Test Provider Connectivity

**Finnhub:**
```bash
curl "https://finnhub.io/api/v1/calendar/economic?from=2025-10-07&to=2025-10-14&token=$FINNHUB_API_KEY"
```
Expected: JSON with `economicCalendar` array

**FMP:**
```bash
curl "https://financialmodelingprep.com/api/v3/economic_calendar?apikey=$FMP_API_KEY"
```
Expected: JSON array (may return 403 on free tier)

### 2. Dry Run (No DMs Sent)

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?days=7&mode=all&limit=10&dry=1"
```

**Expected response:**
```json
{
  "ok": true,
  "provider": "finnhub",
  "events_from_provider": 50,
  "events_from_manual": 0,
  "events_after_filters": 10,
  "sent": 0,
  "dry": true
}
```

### 3. Real Alert Test (Send DMs)

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?minutes=120&mode=major&limit=3"
```

**Expected:**
- Telegram DMs sent to all `econ:subs` chat IDs
- Dedupe keys created: `econ:sent:*` in Redis
- Response: `"sent": <number>`

### 4. Upcoming Events (Voiceflow)

```bash
curl "https://your-domain.vercel.app/api/econ/upcoming?limit=5&lang=bi"
```

**Expected response:**
```json
{
  "ok": true,
  "count": 5,
  "items": [{"country":"United States","event":"CPI y/y","date":"..."}],
  "text": "🔔 الأحداث الاقتصادية القادمة / Upcoming Economic Events..."
}
```

### 5. Monitor Vercel Cron

**Vercel Dashboard → Project → Cron Jobs:**
- Schedule: `*/5 * * * *` (every 5 minutes)
- Path: `/api/cron`
- Check logs for successful runs

---

## How Auto-Alerts Work

### User Flow:
1. User sends `/econ_on` → subscribed to `econ:subs`
2. Cron runs every 5 min
3. Fetches events 5-60 min away from Finnhub/FMP
4. Filters by country + keywords (mode=major)
5. Checks dedupe key (`econ:sent:*`)
6. Sends bilingual DM to all subscribers
7. User receives alert **before** event happens
8. User can reply to alert → agent responds

### No Manual Triggers Needed:
- Cron auto-runs every 5 min (Vercel handles this)
- Events auto-trigger when their time approaches
- Users get alerts automatically (no `/econ_upcoming` call needed)

---

## Query Parameters

### `/api/cron` Options:

```bash
?minutes=60        # Alert window (default: 60 min)
?days=1            # Alternative to minutes (1 day = 1440 min)
?mode=major        # Filter: major events only (default)
?mode=all          # No keyword filtering
?limit=5           # Max events to send (default: 10)
?lang=both         # Bilingual AR+EN (default)
?lang=en           # English only
?lang=ar           # Arabic only
?dry=1             # Test mode (no DMs sent)
?source=manual     # Force manual events only (bypass providers)
```

---

## Troubleshooting

### No events returned?
```bash
# Check if provider keys are set
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?days=7&dry=1"

# Response should show:
# "provider": "finnhub" or "fmp" (not "none")
# "events_from_provider": >0
```

### Alerts not sending?
1. Check `econ:subs` has chat IDs:
   ```bash
   # In Upstash console:
   SMEMBERS econ:subs
   ```
2. Verify bot token works:
   ```bash
   curl "https://api.telegram.org/bot$LIIRAT_BOT_TOKEN/getMe"
   ```
3. Check dedupe keys (may skip if already sent):
   ```bash
   # In Upstash console:
   KEYS econ:sent:*
   ```

### Force manual events only:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-domain.vercel.app/api/cron?source=manual&minutes=60"
```

---

## Rollback Plan

If providers fail, revert to manual mode:

1. **Temporary:** Add `?source=manual` to cron calls
2. **Permanent:** Update `vercel.json`:
   ```json
   {
     "crons": [{
       "path": "/api/cron?source=manual",
       "schedule": "*/5 * * * *"
     }]
   }
   ```
3. **Emergency:** Revert to previous commit:
   ```bash
   git revert HEAD
   git push
   ```

---

## Next Steps

1. ✅ Deploy to Vercel (auto-deploys from `main`)
2. ✅ Verify env vars in Vercel dashboard
3. ✅ Run dry test: `?dry=1`
4. ✅ Monitor first real cron run (check logs)
5. ✅ Test `/econ_upcoming` in Voiceflow
6. ✅ Subscribe test user with `/econ_on`
7. ✅ Wait 5-60 min for next event alert

**Success Criteria:**
- `provider: "finnhub"` in cron response
- DMs deliver to Telegram with real events
- `/econ_upcoming` shows non-empty list
- No duplicate alerts (dedupe working)
