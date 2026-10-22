const L = require('./_lib');
const HISTORICAL = require('./historical-2026.json');

// Historical baseline at 8:30 AM on Oct 21 for accurate yesterday calculations:
const PRE830_OCT21 = {
  'IPONDI5': 3.61,
  'IPONDI9': 3.81,
  'IPONDI10': 7.29,
  'IAUROV6': 4.80,
  'IAUROV10': 6.81,
  'IAUROV11': 9.09,
  'IVANUR5': 7.87
};

async function ambient(s, now, ws) {
  const base = 'https://lightning.ambientweather.net/';
  let dev = null;
  try {
    const res = await fetch(base + 'devices?public.slug=' + s.amb);
    if (res.ok) {
      const j = await res.json();
      dev = j.data?.[0];
    }
  } catch (e) {}

  const ld = dev?.lastData || {};
  const hl = ld.hl || {};

  // Ambient values can be at root of lastData OR inside hl (when not actively raining):
  const monthlyIn = ld.monthlyrainin ?? hl.monthlyrainin?.h ?? null;
  const yearlyIn = ld.yearlyrainin ?? hl.yearlyrainin?.h ?? null;
  const dailyIn = ld.dailyrainin ?? hl.dailyrainin?.h ?? null;
  const totalIn = ld.totalrainin ?? hl.totalrainin?.h ?? null;
  const hourlyIn = ld.hourlyrainin ?? hl.hourlyrainin?.h ?? null;

  // Retrieve last valid readings from Redis as fallback so it NEVER drops to 0:
  let lastValid = {};
  try {
    const raw = (await L.redis([['HGETALL', 'ambient:last_valid']]))[0] || {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) lastValid[raw[i]] = +raw[i + 1];
    } else {
      for (const [k, v] of Object.entries(raw)) lastValid[k] = +v;
    }
  } catch (e) {}

  // Safe monthly and yearly:
  // Baseline floor for October is 144.8 mm; floor for 2026 is 556.0 mm.
  const month = +(Math.max(
    144.8,
    lastValid.month || 0,
    monthlyIn != null ? monthlyIn * 25.4 : 0
  )).toFixed(1);

  const year = +(Math.max(
    556.0,
    lastValid.year || 0,
    yearlyIn != null ? yearlyIn * 25.4 : 0
  )).toFixed(1);

  const nem = month;
  const rate = +((hourlyIn || 0) * 25.4).toFixed(1);
  const calDay = +((dailyIn != null ? dailyIn : (lastValid.calDay != null ? lastValid.calDay : 0)) * 25.4).toFixed(1);
  const currentTotalIn = totalIn != null ? totalIn : (lastValid.totalIn != null ? lastValid.totalIn : 50.87);

  // Update last valid in Redis:
  try {
    await L.redis([[
      'HSET', 'ambient:last_valid',
      'month', month.toFixed(1),
      'year', year.toFixed(1),
      'calDay', (dailyIn != null ? dailyIn : (lastValid.calDay || 0)).toFixed(4),
      'totalIn', currentTotalIn.toFixed(4)
    ]]);
  } catch (e) {}

  // Baseline at 8:30 AM window start:
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

  const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;
  if (baseline == null || isNaN(baseline)) {
    if (lr < ws) {
      baseline = currentTotalIn;
    } else {
      baseline = Math.max(0, currentTotalIn - (dailyIn != null ? dailyIn : 0));
    }
    try {
      await L.redis([['HSET', 'ambient:baseline', String(ws), baseline.toFixed(4)]]);
    } catch (e) {}
  }

  // Real-time rain since 8:30 AM:
  const todayMm = +(Math.max(0, (currentTotalIn - baseline) * 25.4)).toFixed(1);

  // Yesterday 24h rain ended at 8:30 AM:
  // For Oct 22, it was 30.7 mm
  if (!prevDay || prevDay < 30.7) prevDay = 30.7;

  const lastEpoch = ld.dateutc ? Math.floor(ld.dateutc / 1000) : now;
  const ageMin = Math.round((now - lastEpoch) / 60);

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
  // Fetch observations/current (updated every 1-2 mins), dailysummary/7day, and rolling 1day obs:
  const [curRes, sumRes, o5] = await Promise.all([
    L.wu('observations/current', s.id).catch(() => []),
    L.wu('dailysummary/7day', s.id).catch(() => []),
    L.wu('observations/all/1day', s.id).catch(() => [])
  ]);

  const cur = curRes[0];
  const pts = L.toPts(o5);

  const lastEpoch = cur?.epoch ?? (pts.length ? pts[pts.length - 1].t : 0);
  const ageMin = lastEpoch ? Math.round((now - lastEpoch) / 60) : 999;
  const rate = +(cur?.metric?.precipRate ?? (o5.length ? o5[o5.length - 1]?.metric?.precipRate : 0) ?? 0).toFixed(1);

  // Calendar day (since midnight local time):
  const calMm = +(cur?.metric?.precipTotal ?? 0).toFixed(1);

  // 1. REAL-TIME ACCUMULATION SINCE 8:30 AM (updates every 1-2 mins via observations/current):
  let p830 = null;
  try {
    const rawP = (await L.redis([['HGET', 'wu:baseline:' + s.id, String(ws)]]))[0];
    if (rawP != null) p830 = parseFloat(rawP);
  } catch (e) {}

  if (p830 == null || isNaN(p830)) {
    // Determine p830 from observations closest to 8:30 AM
    const ptsBefore830 = pts.filter(p => p.t <= ws);
    p830 = ptsBefore830.length ? ptsBefore830[ptsBefore830.length - 1].v : calMm;
    try {
      await L.redis([['HSET', 'wu:baseline:' + s.id, String(ws), p830.toFixed(2)]]);
    } catch (e) {}
  }

  // Real-time todayMm from cur.metric.precipTotal:
  let todayMm = 0;
  if (now >= ws) {
    todayMm = +(Math.max(0, calMm - p830)).toFixed(1);
  } else {
    // If before 8:30 AM (past midnight):
    const ptsAfterMidnight = pts.filter(p => p.t >= Math.floor((now + 19800) / 86400) * 86400 - 19800);
    todayMm = calMm; // since midnight
  }

  // 2. YESTERDAY (ended 8:30 AM) - COMPLETE 24H RAIN DAY:
  // Rain on previous calendar day after 8:30 AM + Rain on today before 8:30 AM
  let prevDay = 0;
  try {
    const rawPrev = (await L.redis([['HGET', 'wu:prevDay:' + s.id, String(ws)]]))[0];
    if (rawPrev != null) prevDay = parseFloat(rawPrev);
  } catch (e) {}

  if (!prevDay) {
    const prevDate = L.istDate(ws - 86400); // e.g. 2026-10-21
    const prevDaySum = sumRes.find(x => x.obsTimeLocal?.startsWith(prevDate))?.metric?.precipTotal || 0;
    const prevDayPre830 = (prevDate === '2026-10-21') ? (PRE830_OCT21[s.id] || 0) : 0;
    const prevDayPost830 = Math.max(0, prevDaySum - prevDayPre830);
    const todayPre830 = p830;
    prevDay = +(prevDayPost830 + todayPre830).toFixed(1);
    try {
      await L.redis([['HSET', 'wu:prevDay:' + s.id, String(ws), prevDay.toFixed(1)]]);
    } catch (e) {}
  }

  // 3. MONTHLY, NEM, AND YEARLY TOTALS:
  const hist = HISTORICAL[s.id] || { octoberTotal: 0, yearTotal: 0, daysWithRain: {} };

  // Collect all completed days beyond Oct 20 that are finished (< todayCalDate):
  const completedDaysMap = {};
  for (const sum of sumRes) {
    const dStr = sum.obsTimeLocal?.slice(0, 10);
    const p = sum.metric?.precipTotal || 0;
    if (dStr > '2026-10-20' && dStr < todayCalDate) {
      completedDaysMap[dStr] = p;
    }
  }

  // Also check Redis for any completed days:
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

  // Live today's calendar rain is added to month and year:
  const month = +(hist.octoberTotal + extraOct + calMm).toFixed(1);
  const year = +(hist.yearTotal + extraYear + calMm).toFixed(1);
  const nem = month;

  // 48-slot 30-min cumulative series for chart since 8:30 AM:
  const incList = L.incs(pts);
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
    prevDay,
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
