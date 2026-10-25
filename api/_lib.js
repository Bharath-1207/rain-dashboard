const PRIMARY_KEY = 'f6d2efe5720d47ea92efe5720df7eaa8';
const CANDIDATE_KEYS = [
  'f6d2efe5720d47ea92efe5720df7eaa8',
  'e1f10a1e78da46f5b10a1e78da96f525',
  'ff90f212a6984a7390f212a698ea73cc'
];
let K = process.env.WU_API_KEY || PRIMARY_KEY;

// In-memory cache for API endpoints to prevent throttling:
const cache = new Map();

const RU = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const STATIONS = [
  { id: 'IPONDI5', name: 'Mothilal Nagar' },
  { id: 'IPONDI9', name: 'Heritage Town' },
  { id: 'IPONDI10', name: 'Poornakuppam' },
  { id: 'IAUROV6', name: 'Bommayapalayam' },
  { id: 'IAUROV10', name: 'Sarvamangalam' },
  { id: 'IAUROV11', name: 'Auro Orchard' },
  { id: 'IVANUR5', name: 'Puthurai' },
  { id: 'AMBIENT', name: 'Shreelakam Lawspet', amb: '7fc335428501d47401fe97b23cd0e7fd' },
];

// 08:30 IST = 03:00 UTC = 10800s.
// winStart(t): epoch of 08:30 IST window start (most recent 08:30 IST <= t)
const winStart = t => Math.floor((t - 10800) / 86400) * 86400 + 10800;

// istDate(t): IST calendar date (YYYY-MM-DD) for epoch t
const istDate = t => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

const redis = async cmds => {
  if (!RU) return [];
  try {
    const r = await fetch(RU + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds)
    });
    return (await r.json()).map(x => x.result);
  } catch (e) {
    return [];
  }
};

const scrapeActiveKey = async () => {
  try {
    const r = await fetch('https://www.wunderground.com/dashboard/pws/IPONDI9', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"API_KEY":\s*"([a-f0-9]{32})"/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
};

const getKey = async force => {
  if (K && !force) return K;
  if (process.env.WU_API_KEY && !force) return (K = process.env.WU_API_KEY);

  // Check Redis for active key if forced:
  if (force) {
    try {
      const redisKey = (await redis([['GET', 'wu:active_key']]))[0];
      if (redisKey && redisKey !== K) {
        const testRes = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=IPONDI9&format=json&units=m&numericPrecision=decimal&apiKey=${redisKey}`);
        if (testRes.status === 200 || testRes.status === 204) return (K = redisKey);
      }
    } catch (e) {}
  }

  // Test candidate keys:
  for (const candidate of CANDIDATE_KEYS) {
    if (candidate === K && force) continue;
    try {
      const testRes = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=IPONDI9&format=json&units=m&numericPrecision=decimal&apiKey=${candidate}`);
      if (testRes.status === 200 || testRes.status === 204) {
        K = candidate;
        try { await redis([['SET', 'wu:active_key', candidate]]); } catch (e) {}
        return K;
      }
    } catch (e) {}
  }

  // Scrape fresh active key directly from wunderground.com:
  const scraped = await scrapeActiveKey();
  if (scraped) {
    K = scraped;
    try { await redis([['SET', 'wu:active_key', scraped]]); } catch (e) {}
    return K;
  }

  return (K = PRIMARY_KEY);
};

const wu = async (path, id, extra = '', retry = true) => {
  const cacheKey = `${path}:${id}:${extra}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Cache 7day summary for 120s, 1day observations for 60s, current for 15s to prevent throttling:
  const ttl = path.includes('dailysummary') ? 120000 : path.includes('all/1day') ? 60000 : 15000;
  if (cached && (now - cached.time) < ttl) {
    return cached.data;
  }

  const key = await getKey();
  const r = await fetch(`https://api.weather.com/v2/pws/${path}?stationId=${id}&format=json&units=m&numericPrecision=decimal${extra}&apiKey=${key}`);

  if (r.status === 204) {
    const data = [];
    cache.set(cacheKey, { time: now, data });
    return data;
  }

  if ((r.status === 401 || r.status === 403) && retry) {
    await getKey(true);
    return wu(path, id, extra, false);
  }

  if (!r.ok) {
    if (cached) return cached.data;
    throw new Error(`${id} ${path} HTTP ${r.status}`);
  }

  const j = await r.json();
  const data = j.observations || j.summaries || [];
  cache.set(cacheKey, { time: now, data });
  return data;
};

const toPts = o => (o || [])
  .filter(x => x.metric && x.metric.precipTotal != null)
  .map(x => ({ t: x.epoch, v: x.metric.precipTotal }))
  .sort((a, b) => a.t - b.t);

// Extracts delta rainfall increments between consecutive 5-min readings.
// Handles gauge reset at local midnight.
const incs = p => {
  const o = [];
  for (let i = 1; i < p.length; i++) {
    let d = p[i].v - p[i - 1].v;
    if (d < 0) d = p[i].v; // midnight reset
    if (d > 0) o.push({ t0: p[i - 1].t, t1: p[i].t, d });
  }
  return o;
};

module.exports = { STATIONS, winStart, istDate, redis, wu, toPts, incs };
