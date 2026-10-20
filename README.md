# Setup
1. Vercel dashboard -> Storage/Marketplace -> add **Upstash Redis** (auto-adds UPSTASH_REDIS_REST_URL / _TOKEN).
2. Env var: BACKFILL_SECRET (any password). No Wunderground key needed.
3. Deploy (`vercel --prod` or GitHub import).
4. Backfill once per station per month, e.g.
   https://YOURSITE.vercel.app/api/backfill?station=IPONDI5&from=2026-10-01&to=2026-10-20&secret=XXX
