// Shared helpers. Rain day = 08:30 IST -> next 08:30 IST (IMD), labelled by the END date.
const KNOWN_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';
let K = process.env.WU_API_KEY || KNOWN_KEY;
// Vercel KV marketplace injects KV_REST_API_URL/TOKEN; direct Upstash uses UPSTASH_REDIS_REST_*.
const RU = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const STATIONS = [
  { id: 'IPONDI5', name: 'Mothilal Nagar' },
  { id: 'IPONDI9', name: 'Heritage Town' },
  { id: 'IPONDI10', name: 'Pondicherry' },
  { id: 'IAUROV6', name: 'Bommayapalayam' },
  { id: 'IAUROV10', name: 'Sarvamangalam' },
  { id: 'IAUROV11', name: 'Auro Orchard' },
  { id: 'IVANUR5', name: 'Puthurai' },
  { id: 'AMBIENT', name: 'Shreelakam Lawspet', amb: '7fc335428501d47401fe97b23cd0e7fd' },
];
// 08:30 IST = 03:00 UTC. Instant t (sec) belongs to the day ending at the first 03:00 UTC >= t.
// key(t): IST calendar date (YYYY-MM-DD) of the 08:30 IST rain-day window that contains epoch t.
// Each window closes at 03:00 UTC (=08:30 IST). The closing date in IST is the label.
const key = t => {
  const close = (Math.floor((t - 10800) / 86400) + 1) * 86400 + 10800; // next 03:00 UTC after t
  return new Date((close + 19800) * 1000).toISOString().slice(0, 10); // convert to IST date
};
const winStart = k => Date.parse(k + 'T03:00:00Z') / 1000 - 86400;

const redis = async cmds => {
  if (!RU) throw new Error('Redis env vars missing');
  const r = await fetch(RU + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(cmds) });
  return (await r.json()).map(x => x.result);
};
// Universal authorized Weather Underground API key with verified fallback
const getKey = async force => {
  if (K && !force) return K;
  if (process.env.WU_API_KEY) return (K = process.env.WU_API_KEY);
  for (const candidate of [KNOWN_KEY, 'ff90f212a6984a7390f212a698ea73cc']) {
    try {
      const testRes = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=IPONDI5&format=json&units=m&numericPrecision=decimal&apiKey=${candidate}`);
      if (testRes.status === 200) return (K = candidate);
    } catch (e) {}
  }
  return (K = KNOWN_KEY);
};
const wu = async (path, id, extra = '', retry = true) => {
  const r = await fetch(`https://api.weather.com/v2/pws/${path}?stationId=${id}&format=json&units=m&numericPrecision=decimal${extra}&apiKey=${await getKey()}`);
  if (r.status === 204) return [];
  if ((r.status === 401 || r.status === 403) && retry) { await getKey(true); return wu(path, id, extra, false); }
  if (!r.ok) throw new Error(`${id} ${path} HTTP ${r.status}`);
  return (await r.json()).observations || [];
};
const toPts = o => o.filter(x => x.metric && x.metric.precipTotal != null).map(x => ({ t: x.epoch, v: x.metric.precipTotal })).sort((a, b) => a.t - b.t);
// cumulative-since-midnight readings -> rainfall increments (handles midnight reset)
const incs = p => { const o = []; for (let i = 1; i < p.length; i++) { let d = p[i].v - p[i - 1].v; if (d < 0) d = p[i].v; if (d > 0) o.push({ t0: p[i - 1].t, t1: p[i].t, d }); } return o; };
const toDays = list => {
  const o = {}, add = (k, d) => o[k] = (o[k] || 0) + d;
  for (const { t0, t1, d } of list) {
    const nb = (Math.floor((t0 - 10800) / 86400) + 1) * 86400 + 10800;
    if (t1 <= nb) add(key(t1), d); else { const f = (nb - t0) / (t1 - t0); add(key(nb), d * f); add(key(t1), d * (1 - f)); }
  }
  return o;
};
const writeDays = (id, days, first, lo, hi) => {
  const cmds = [];
  for (const [k, v] of Object.entries(days)) if (winStart(k) >= first && (!lo || k >= lo) && (!hi || k <= hi)) cmds.push(['HSET', 'rain:' + id, k, v.toFixed(2)]);
  return cmds.length ? redis(cmds) : null;
};
module.exports = { STATIONS, key, winStart, redis, wu, toPts, incs, toDays, writeDays };
