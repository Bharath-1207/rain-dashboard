// Shared helpers for Pondy & Auroville Rain Dashboard
const KNOWN_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';
let K = process.env.WU_API_KEY || KNOWN_KEY;

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
  if ((r.status === 401 || r.status === 403) && retry) {
    await getKey(true);
    return wu(path, id, extra, false);
  }
  if (!r.ok) throw new Error(`${id} ${path} HTTP ${r.status}`);
  const j = await r.json();
  return j.observations || j.summaries || [];
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
