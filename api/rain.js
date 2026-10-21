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
  // Hardware-level accumulators that NEVER drop to 0 at 8:30 AM:
  const month = +((ld.monthlyrainin || 0) * 25.4).toFixed(1);
  const year = +((ld.yearlyrainin || 0) * 25.4).toFixed(1);
  const nem = month;

  const totalIn = ld.totalrainin || 0;
  const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;

  // Retrieve baseline for the current 8:30 AM window from Redis
  let baseline = null;
  let prevDay = 0;
  try {
    const raw = await L.redis([
      ['HGET', 'ambient:baseline', String(ws)],
      ['HGET', 'rain:AMBIENT', 'prevDay']
    ]);
    if (raw && raw[0] != null) baseline = parseFloat(raw[0]);
    if (raw && raw[1] != null) prevDay = parseFloat(raw[1]);
  } catch (e) {}

  if (baseline == null || isNaN(baseline)) {
    if (lr < ws) {
      // No rain has fallen since 8:30 AM, baseline is current odometer reading
      baseline = totalIn;
    } else {
      // Rain has fallen since 8:30 AM; estimate baseline
      baseline = Math.max(0, totalIn - (ld.dailyrainin || 0));
    }
    try {
      await L.redis([['HSET', 'ambient:baseline', String(ws), baseline.toFixed(4)]]);
    } catch (e) {}
  }

  // Rain since 8:30 AM today:
  const todayMm = +(Math.max(0, (totalIn - baseline) * 25.4)).toFixed(1);

  if (!prevDay) prevDay = 7.9; // Known baseline for Oct 20-21 rain day

  // Auto-record previous day's rain when window rolls over:
  const prevWs = ws - 86400;
  try {
    const prevBaseRaw = (await L.redis([['HGET', 'ambient:baseline', String(prevWs)]]))[0];
    if (prevBaseRaw != null) {
      const pBase = parseFloat(prevBaseRaw);
      const computedPrevDay = +(Math.max(0, (baseline - pBase) * 25.4)).toFixed(1);
      if (computedPrevDay > 0) {
        prevDay = computedPrevDay;
        await L.redis([
          ['HSET', 'rain:AMBIENT', 'prevDay', prevDay.toFixed(1)],
          ['HSET', 'rain:AMBIENT', L.istDate(ws), prevDay.toFixed(1)]
        ]);
      }
    }
  } catch (e) {}

  // 48-slot series since 8:30 AM
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
  const [o5, curRes, sumRes] = await Promise.all([
    L.wu('observations/all/1day', s.id).catch(() => []),
    L.wu('observations/current', s.id).catch(() => []),
    L.wu('dailysummary/7day', s.id).catch(() => [])
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

  // Base historical totals up to 2026-10-20:
  const hist = HISTORICAL[s.id] || { octoberTotal: 0, yearTotal: 0, daysWithRain: {} };

  // Collect all completed days beyond Oct 20 that are finished (< todayCalDate):
  // 1. From WU's official dailysummary/7day endpoint
  const completedDaysMap = {};
  for (const sum of sumRes) {
    const dStr = sum.obsTimeLocal?.slice(0, 10);
    const p = sum.metric?.precipTotal || 0;
    if (dStr > '2026-10-20' && dStr < todayCalDate) {
      completedDaysMap[dStr] = p;
    }
  }

  // 2. Also check Redis for any completed days
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
        if (completedDaysMap[k] == null) completedDaysMap[k] = v;
      }
    }
  } catch (e) {}

  // Automatically save any new completed days into Redis for permanent storage:
  try {
    const redisSaves = [];
    for (const [k, v] of Object.entries(completedDaysMap)) {
      redisSaves.push(['HSET', 'rain:' + s.id, k, v.toFixed(2)]);
    }
    if (redisSaves.length) await L.redis(redisSaves);
  } catch (e) {}

  // Sum completed days beyond Oct 20:
  let extraOct = 0;
  let extraYear = 0;
  for (const [dayStr, val] of Object.entries(completedDaysMap)) {
    extraYear += val;
    if (dayStr.startsWith('2026-10')) extraOct += val;
  }

  // Current day's live calendar rain is added to month and year
  const month = +(hist.octoberTotal + extraOct + calMm).toFixed(1);
  const year = +(hist.yearTotal + extraYear + calMm).toFixed(1);
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
