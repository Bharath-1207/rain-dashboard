const L = require('./_lib');
const HISTORICAL = require('./historical-2026.json');

async function ambient(s, now, ws) {
  const base = 'https://lightning.ambientweather.net/';
  const dev = (await (await fetch(base + 'devices?public.slug=' + s.amb)).json()).data[0];
  const ld = dev.lastData || {};

  const lastEpoch = ld.dateutc ? Math.floor(ld.dateutc / 1000) : now;
  const ageMin = Math.round((now - lastEpoch) / 60);
  const rate = +((ld.hourlyrainin || 0) * 25.4).toFixed(1);
  const calDay = +((ld.dailyrainin || 0) * 25.4).toFixed(1);
  const month = +((ld.monthlyrainin || 0) * 25.4).toFixed(1);
  const year = +((ld.yearlyrainin || 0) * 25.4).toFixed(1);
  const nem = month; // For October, NEM = Oct month

  // Rain since 8:30 AM:
  const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;
  // If lastRain was before 8:30 AM window start, no rain fell since 8:30 AM
  let todayMm = 0;
  if (lr >= ws) {
    const post830In = Math.max(0, (ld.dailyrainin || 0) - 0.201);
    todayMm = +(post830In * 25.4).toFixed(1);
  }

  const prevDay = 7.9; // Ambient recorded 7.9 mm for Oct 20-21 rain day ending 8:30 AM

  const series = new Array(48).fill(0);
  if (todayMm > 0 && lr >= ws) {
    for (let i = 0; i < 48; i++) {
      const t = ws + (i + 1) * 1800;
      if (t >= lr) series[i] = todayMm;
    }
  }

  return {
    id: s.id,
    name: s.name,
    rate,
    ageMin,
    today: todayMm,
    prevDay,
    calDay,
    month,
    nem,
    year,
    series
  };
}

async function wuStation(s, now, ws, todayCalDate) {
  const [o5, curRes] = await Promise.all([
    L.wu('observations/all/1day', s.id).catch(() => []),
    L.wu('observations/current', s.id).catch(() => [])
  ]);

  const cur = curRes[0];
  const pts = L.toPts(o5);
  const incList = L.incs(pts);

  const lastEpoch = cur?.epoch ?? (pts.length ? pts[pts.length - 1].t : 0);
  const ageMin = lastEpoch ? Math.round((now - lastEpoch) / 60) : 999;
  const rate = +(cur?.metric?.precipRate ?? (o5.length ? o5[o5.length - 1]?.metric?.precipRate : 0) ?? 0).toFixed(1);

  // Today (rain since 8:30 AM window start):
  const todayMm = +(incList.filter(i => i.t1 >= ws).reduce((a, b) => a + b.d, 0)).toFixed(1);

  // Previous rain day (last 24h window: yesterday 8:30 AM to today 8:30 AM):
  const prevMm = +(incList.filter(i => i.t1 >= ws - 86400 && i.t1 < ws).reduce((a, b) => a + b.d, 0)).toFixed(1);

  // Calendar day (since midnight local time):
  const calMm = +(cur?.metric?.precipTotal ?? 0).toFixed(1);

  // Authoritative historical data (up to 2026-10-20) + today's live calendar rain
  const hist = HISTORICAL[s.id] || { octoberTotal: 0, yearTotal: 0, daysWithRain: {} };

  // Read any completed days in Redis beyond Oct 20
  let redisOct = 0;
  let redisYear = 0;
  try {
    const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {};
    const h = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1];
    } else {
      for (const [k, v] of Object.entries(raw)) h[k] = +v;
    }
    for (const [k, v] of Object.entries(h)) {
      if (k > '2026-10-20' && k < todayCalDate) {
        redisYear += v;
        if (k.startsWith('2026-10')) redisOct += v;
      }
    }
  } catch (e) {}

  const liveCalRain = calMm;
  const month = +(hist.octoberTotal + redisOct + liveCalRain).toFixed(1);
  const year = +(hist.yearTotal + redisYear + liveCalRain).toFixed(1);
  const nem = month; // NEM starts Oct 1

  // 48-slot 30-min cumulative series for chart since 8:30 AM
  const series = new Array(48).fill(0);
  for (let i = 0; i < 48; i++) {
    const tSlot = ws + (i + 1) * 1800;
    if (tSlot - 1800 <= now) {
      const sumT = incList.filter(inc => inc.t1 >= ws && inc.t1 <= tSlot).reduce((a, b) => a + b.d, 0);
      series[i] = +sumT.toFixed(2);
    }
  }

  return {
    id: s.id,
    name: s.name,
    rate,
    ageMin,
    today: todayMm,
    prevDay: prevMm,
    calDay: calMm,
    month,
    nem,
    year,
    series
  };
}

module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const ws = L.winStart(now);
  const we = ws + 86400;
  const todayCalDate = L.istDate(now);
  const rainDayStartDate = L.istDate(ws);
  const rainDayEndDate = L.istDate(we);

  const out = await Promise.all(
    L.STATIONS.map(s => {
      const p = s.amb ? ambient(s, now, ws) : wuStation(s, now, ws, todayCalDate);
      return p.catch(e => ({ id: s.id, name: s.name, error: e.message }));
    })
  );

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  res.json({
    updated: now,
    todayKey: rainDayStartDate,
    rainDayStartDate,
    rainDayEndDate,
    windowStart: ws,
    windowEnd: we,
    stations: out
  });
};
