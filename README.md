# Liirat Economic Alerts

Telegram bot for economic calendar alerts.

## Setup

1. **Vercel KV Setup:**
   - Create Vercel KV store
   - Add `KV_REST_API_URL` and `KV_REST_API_TOKEN` to environment variables

2. **Environment Variables:**
   ```
   CRON_SECRET=<random-string>
   KV_REST_API_URL=<from-vercel-kv>
   KV_REST_API_TOKEN=<from-vercel-kv>
   ```

3. **Voiceflow Integration:**
   - Create global intents for `/econ_on` and `/econ_off`
   - API endpoints:
     - Subscribe: `POST /api/econ/subscribe` with `{"chat_id": "123", "username": "user"}`
     - Unsubscribe: `POST /api/econ/unsubscribe` with `{"chat_id": "123"}`

## User Flow

1. User sends `/econ_on` to @liiratnews_bot
2. Voiceflow calls `/api/econ/subscribe` endpoint
3. User gets confirmation
4. Cron runs every 15 min, sends alerts to subscribed users
5. Alerts appear in 1:1 chat with bot
6. User can reply to alerts to ask agent

## Commands (Voiceflow Intents)

- `/econ_on` - Subscribe to alerts
- `/econ_off` - Unsubscribe from alerts
- `/alerts` - Info about alert system (doesn't trigger agent)
- `/packages` - Coming soon message
- `/playtoearn` - Coming soon message
