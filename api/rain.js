const L = require('./_lib');
const HISTORICAL = require('./historical-2026.json');

// Known verified benchmarks for past rain days ending at 8:30 AM IST (keyed by window end date):
const KNOWN_PREV = {
  // Rain day Oct 21 8:30am -> Oct 22 8:30am:
  '2026-10-22': {
    'IPONDI9': 68.1,
    'IPONDI5': 35.0,
    'IPONDI10': 3.8,
    'IAUROV6': 12.2,
    'IAUROV10': 15.8,
    'IAUROV11': 15.5,
    'IVANUR5': 35.8,
    'AMBIENT': 30.7
  },
  // Rain day Oct 22 8:30am -> Oct 23 8:30am:
  '2026-10-23': {
    'IPONDI9': 100.3,
    'IPONDI5': 25.2,
    'IPONDI10': 0.0,
    'IAUROV6': 94.8,
    'IAUROV10': 42.0,
    'IAUROV11': 38.1,
    'IVANUR5': 23.9,
    'AMBIENT': 34.8
  }
};

// Known baselines at 8:30 AM IST on specific calendar days (authoritative fallback):
const KNOWN_BASELINES = {
  '2026-10-22': {
    'IPONDI9': 10.20,
    'IPONDI5': 4.80,
    'IPONDI10': 3.51,
    'IAUROV6': 4.29,
    'IAUROV10': 5.00,
    'IAUROV11': 5.31,
    'IVANUR5': 8.64,
    'AMBIENT': 50.87
  },
  '2026-10-23': {
    'IPONDI9': 100.10,
    'IPONDI5': 25.20,
    'IPONDI10': 0.00,
    'IAUROV6': 94.79,
    'IAUROV10': 42.01,
    'IAUROV11': 38.10,
    'IVANUR5': 23.88,
    'AMBIENT': 52.24
  }
};

async function ambient(s, now, ws, todayCalDate, rainDayStartDate) {
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

  // Ambient values can be at root of lastData OR inside hl (when station is not actively receiving rain):
  const monthlyIn = ld.monthlyrainin ?? hl.monthlyrainin?.h ?? null;
  const yearlyIn = ld.yearlyrainin ?? hl.yearlyrainin?.h ?? null;
  const dailyIn = ld.dailyrainin ?? hl.dailyrainin?.h ?? null;
  const totalIn = ld.totalrainin ?? hl.totalrainin?.h ?? null;
  const hourlyIn = ld.hourlyrainin ?? hl.hourlyrainin?.h ?? null;

  // Retrieve last valid readings from Redis as persistent backup:
  let lastValid = {};
  try {
    const raw = (await L.redis([['HGETALL', 'ambient:last_valid']]))[0] || {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) lastValid[raw[i]] = raw[i + 1];
    } else {
      for (const [k, v] of Object.entries(raw)) lastValid[k] = v;
    }
  } catch (e) {}

  // Safe monthly, yearly, and totalrainin with permanent floor protections:
  // Base October floor is 379.7 mm (verified Oct 2026 total); Year floor is 790.9 mm. It can NEVER drop to 0!
  const oct = +(Math.max(
    379.7,
    lastValid.oct ? parseFloat(lastValid.oct) : (lastValid.month ? parseFloat(lastValid.month) : 0),
    todayCalDate.startsWith('2026-10') && monthlyIn != null ? monthlyIn * 25.4 : 0
  )).toFixed(1);

  const nov = +(Math.max(
    0,
    lastValid.nov ? parseFloat(lastValid.nov) : 0,
    todayCalDate.startsWith('2026-11') && monthlyIn != null ? monthlyIn * 25.4 : 0
  )).toFixed(1);

  const dec = +(Math.max(
    0,
    lastValid.dec ? parseFloat(lastValid.dec) : 0,
    todayCalDate.startsWith('2026-12') && monthlyIn != null ? monthlyIn * 25.4 : 0
  )).toFixed(1);

  const nem = +(oct + nov + dec).toFixed(1);

  const year = +(Math.max(
    790.9,
    lastValid.year ? parseFloat(lastValid.year) : 0,
    yearlyIn != null ? yearlyIn * 25.4 : 0
  )).toFixed(1);

  const month = todayCalDate.startsWith('2026-11') ? nov : (todayCalDate.startsWith('2026-12') ? dec : oct);
  const rate = +((hourlyIn || 0) * 25.4).toFixed(1);

  // Calendar day: preserve across temporary outages, but respect day change:
  const isSameCalDayAsLastValid = lastValid.calDayDate === todayCalDate;
  const calDay = +(
    (dailyIn != null
      ? dailyIn
      : (isSameCalDayAsLastValid && lastValid.calDay != null ? parseFloat(lastValid.calDay) : 0)
    ) * 25.4
  ).toFixed(1);

  const currentTotalIn = totalIn != null
    ? totalIn
    : (lastValid.totalIn != null ? parseFloat(lastValid.totalIn) : 52.24);

  // Update last valid in Redis:
  try {
    await L.redis([[
      'HSET', 'ambient:last_valid',
      'oct', oct.toFixed(1),
      'nov', nov.toFixed(1),
      'dec', dec.toFixed(1),
      'month', month.toFixed(1),
      'year', year.toFixed(1),
      'calDay', (dailyIn != null ? dailyIn : (isSameCalDayAsLastValid && lastValid.calDay ? parseFloat(lastValid.calDay) : 0)).toFixed(4),
      'calDayDate', todayCalDate,
      'totalIn', currentTotalIn.toFixed(4)
    ]]);
  } catch (e) {}

  // Baseline at 8:30 AM window start:
  let baseline = null;
  try {
    const raw = (await L.redis([['HGET', 'ambient:baseline', String(ws)]]))[0];
    if (raw != null && !isNaN(parseFloat(raw))) baseline = parseFloat(raw);
  } catch (e) {}

  if (baseline == null || isNaN(baseline)) {
    const knownBase = KNOWN_BASELINES[rainDayStartDate]?.['AMBIENT'];
    if (knownBase != null) {
      baseline = knownBase;
    } else {
      const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;
      if (lr < ws) {
        baseline = currentTotalIn;
      } else {
        baseline = Math.max(0, currentTotalIn - (dailyIn != null ? dailyIn : 0));
      }
    }
    try {
      await L.redis([['HSET', 'ambient:baseline', String(ws), baseline.toFixed(4)]]);
    } catch (e) {}
  }

  // Real-time rain since 8:30 AM today using lifetime odometer:
  const todayMm = +(Math.max(0, (currentTotalIn - baseline) * 25.4)).toFixed(1);

  // Yesterday 24h rain ended at 8:30 AM:
  let prevDay = null;
  try {
    const rawPrev = (await L.redis([['HGET', 'ambient:prevDay', String(ws)]]))[0];
    if (rawPrev != null && !isNaN(parseFloat(rawPrev))) prevDay = parseFloat(rawPrev);
  } catch (e) {}

  if (prevDay == null) {
    let pBase = null;
    try {
      const prevBaseRaw = (await L.redis([['HGET', 'ambient:baseline', String(ws - 86400)]]))[0];
      if (prevBaseRaw != null && !isNaN(parseFloat(prevBaseRaw))) pBase = parseFloat(prevBaseRaw);
    } catch (e) {}

    if (pBase == null) {
      const prevDate = L.istDate(ws - 86400);
      pBase = KNOWN_BASELINES[prevDate]?.['AMBIENT'] ?? null;
    }

    if (pBase != null && baseline != null) {
      prevDay = +(Math.max(0, (baseline - pBase) * 25.4)).toFixed(1);
    }
  }

  // If still null, check known benchmark for this window end date:
  if (prevDay == null) {
    prevDay = KNOWN_PREV[rainDayStartDate]?.['AMBIENT'] ?? 0;
  }

  try {
    await L.redis([['HSET', 'ambient:prevDay', String(ws), prevDay.toFixed(1)]]);
  } catch (e) {}

  const lastEpoch = ld.dateutc ? Math.floor(ld.dateutc / 1000) : now;
  const ageMin = Math.max(0, Math.round((now - lastEpoch) / 60));

  const series = new Array(48).fill(0);
  const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;
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
    oct,
    nov,
    dec,
    month,
    nem,
    year,
    series
  };
}

async function wuStation(s, now, ws, todayCalDate, rainDayStartDate) {
  // Fetch observations/current (updated every 1-2 mins), dailysummary/7day, and rolling 1day obs:
  const [curRes, sumRes, o5] = await Promise.all([
    L.wu('observations/current', s.id).catch(() => []),
    L.wu('dailysummary/7day', s.id).catch(() => []),
    L.wu('observations/all/1day', s.id).catch(() => [])
  ]);

  const cur = curRes[0];
  const pts = L.toPts(o5);

  const lastEpoch = cur?.epoch ?? (pts.length ? pts[pts.length - 1].t : 0);
  const ageMin = lastEpoch ? Math.max(0, Math.round((now - lastEpoch) / 60)) : 999;
  const rate = +(cur?.metric?.precipRate ?? (o5.length ? o5[o5.length - 1]?.metric?.precipRate : 0) ?? 0).toFixed(1);

  // Calendar day (since midnight local time):
  const calMm = +(cur?.metric?.precipTotal ?? 0).toFixed(1);

  // 1. BASELINE AT 8:30 AM FOR CURRENT RAIN DAY (updates every 1-2 mins via observations/current):
  let p830 = null;
  try {
    const rawP = (await L.redis([['HGET', 'wu:baseline:' + s.id, String(ws)]]))[0];
    if (rawP != null && !isNaN(parseFloat(rawP))) p830 = parseFloat(rawP);
  } catch (e) {}

  if (p830 == null) {
    const ptsBefore830 = pts.filter(p => p.t <= ws);
    if (ptsBefore830.length) {
      p830 = ptsBefore830[ptsBefore830.length - 1].v;
    } else {
      p830 = KNOWN_BASELINES[rainDayStartDate]?.[s.id] ?? calMm;
    }
    try {
      await L.redis([['HSET', 'wu:baseline:' + s.id, String(ws), p830.toFixed(2)]]);
    } catch (e) {}
  }

  // Real-time todayMm from cur.metric.precipTotal:
  let todayMm = 0;
  const isSameCalendarDay = (L.istDate(now) === L.istDate(ws));
  if (isSameCalendarDay) {
    todayMm = +(Math.max(0, calMm - p830)).toFixed(1);
  } else {
    // Past midnight before 8:30 AM tomorrow:
    const prevDate = L.istDate(ws);
    const prevDaySum = sumRes.find(x => x.obsTimeLocal?.startsWith(prevDate))?.metric?.precipTotal || 0;
    const rainPost830 = Math.max(0, prevDaySum - p830);
    todayMm = +(rainPost830 + calMm).toFixed(1);
  }

  // 2. YESTERDAY (ended 8:30 AM) - COMPLETE 24H RAIN DAY:
  let prevDay = null;
  try {
    const rawPrev = (await L.redis([['HGET', 'wu:prevDay:' + s.id, String(ws)]]))[0];
    if (rawPrev != null && !isNaN(parseFloat(rawPrev))) prevDay = parseFloat(rawPrev);
  } catch (e) {}

  if (prevDay == null) {
    const prevDate = L.istDate(ws - 86400);
    const prevDaySum = sumRes.find(x => x.obsTimeLocal?.startsWith(prevDate))?.metric?.precipTotal || 0;
    let prevBase830 = null;
    try {
      const bRaw = (await L.redis([['HGET', 'wu:baseline:' + s.id, String(ws - 86400)]]))[0];
      if (bRaw != null && !isNaN(parseFloat(bRaw))) prevBase830 = parseFloat(bRaw);
    } catch (e) {}

    if (prevBase830 == null) {
      prevBase830 = KNOWN_BASELINES[prevDate]?.[s.id] ?? 0;
    }

    const prevDayPost830 = Math.max(0, prevDaySum - prevBase830);
    const todayPre830 = p830;
    prevDay = +(prevDayPost830 + todayPre830).toFixed(1);

    try {
      await L.redis([['HSET', 'wu:prevDay:' + s.id, String(ws), prevDay.toFixed(1)]]);
    } catch (e) {}
  }

  // If calculation resulted in 0 or null and we have a verified known benchmark for this end date:
  if ((prevDay == null || prevDay === 0) && KNOWN_PREV[rainDayStartDate]?.[s.id] != null) {
    prevDay = KNOWN_PREV[rainDayStartDate][s.id];
  }

  // 3. MONTHLY, NEM, AND YEARLY TOTALS:
  const hist = HISTORICAL[s.id] || { octoberTotal: 0, yearTotal: 0, daysWithRain: {} };

  // Collect all completed days beyond Oct 21 from dailysummary/7day:
  const completedDaysMap = {};
  for (const sum of sumRes) {
    const dStr = sum.obsTimeLocal?.slice(0, 10);
    const p = sum.metric?.precipTotal || 0;
    if (dStr > '2026-10-21' && dStr < todayCalDate) {
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
      if (k > '2026-10-21' && k < todayCalDate) {
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

  // Sum completed days beyond Oct 21 by month:
  let extraOct = 0;
  let extraNov = 0;
  let extraDec = 0;
  let extraYear = 0;
  for (const [dayStr, val] of Object.entries(completedDaysMap)) {
    extraYear += val;
    if (dayStr.startsWith('2026-10')) extraOct += val;
    else if (dayStr.startsWith('2026-11')) extraNov += val;
    else if (dayStr.startsWith('2026-12')) extraDec += val;
  }

  // Live today's calendar rain is added to current active month and year:
  const liveOct = todayCalDate.startsWith('2026-10') ? calMm : 0;
  const liveNov = todayCalDate.startsWith('2026-11') ? calMm : 0;
  const liveDec = todayCalDate.startsWith('2026-12') ? calMm : 0;

  const oct = +(hist.octoberTotal + extraOct + liveOct).toFixed(1);
  const nov = +(extraNov + liveNov).toFixed(1);
  const dec = +(extraDec + liveDec).toFixed(1);
  const nem = +(oct + nov + dec).toFixed(1);
  const year = +(hist.yearTotal + extraYear + calMm).toFixed(1);
  const month = todayCalDate.startsWith('2026-11') ? nov : (todayCalDate.startsWith('2026-12') ? dec : oct);

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
    oct,
    nov,
    dec,
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
      const p = s.amb
        ? ambient(s, now, ws, todayCalDate, rainDayStartDate)
        : wuStation(s, now, ws, todayCalDate, rainDayStartDate);
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
