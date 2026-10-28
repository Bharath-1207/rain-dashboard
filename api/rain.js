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

async function ambient(s, now, ws, todayCalDate, rainDayStartDate, rainDayEndDate, activeRainMonth) {
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

  const currentTotalIn = totalIn != null
    ? totalIn
    : (lastValid.totalIn != null ? parseFloat(lastValid.totalIn) : 52.24);

  // IMD MONTHLY TALLIES PER 08:30 AM CUTOFFS:
  // Oct 31 08:30 AM to Nov 01 08:30 AM belongs to November
  // Nov 30 08:30 AM to Dec 01 08:30 AM belongs to December
  let oct = 379.7;
  let nov = 0.0;
  let dec = 0.0;

  if (ws < L.OCT31_830) {
    // Up to Oct 31 08:30 AM IST: October is actively accumulating (floor 379.7 mm)
    oct = +(Math.max(
      379.7,
      lastValid.oct ? parseFloat(lastValid.oct) : (lastValid.month ? parseFloat(lastValid.month) : 0),
      todayCalDate.startsWith('2026-10') && monthlyIn != null ? monthlyIn * 25.4 : 0
    )).toFixed(1);
    nov = 0.0;
    dec = 0.0;
  } else if (ws < L.NOV30_830) {
    // Rain day Oct 31 08:30 AM to Nov 30 08:30 AM: November is accumulating
    // October is closed and permanently frozen at final total (minimum 379.7 mm):
    oct = +(Math.max(
      379.7,
      lastValid.oct_final ? parseFloat(lastValid.oct_final) : 0,
      lastValid.oct ? parseFloat(lastValid.oct) : 0
    )).toFixed(1);

    let novStartOdo = null;
    if (lastValid.nov_start_odo && !isNaN(parseFloat(lastValid.nov_start_odo))) {
      novStartOdo = parseFloat(lastValid.nov_start_odo);
    } else {
      try {
        const rawOdo = (await L.redis([['HGET', 'ambient:baseline', String(L.OCT31_830)]]))[0];
        if (rawOdo != null && !isNaN(parseFloat(rawOdo))) novStartOdo = parseFloat(rawOdo);
      } catch (e) {}
    }
    if (novStartOdo == null) novStartOdo = currentTotalIn;

    nov = +(Math.max(
      0,
      lastValid.nov ? parseFloat(lastValid.nov) : 0,
      (currentTotalIn - novStartOdo) * 25.4
    )).toFixed(1);
    dec = 0.0;
  } else if (ws < L.DEC31_830) {
    // Rain day Nov 30 08:30 AM to Dec 31 08:30 AM: December is accumulating
    oct = +(Math.max(
      379.7,
      lastValid.oct_final ? parseFloat(lastValid.oct_final) : 0,
      lastValid.oct ? parseFloat(lastValid.oct) : 0
    )).toFixed(1);

    nov = +(Math.max(
      0,
      lastValid.nov_final ? parseFloat(lastValid.nov_final) : 0,
      lastValid.nov ? parseFloat(lastValid.nov) : 0
    )).toFixed(1);

    let decStartOdo = null;
    if (lastValid.dec_start_odo && !isNaN(parseFloat(lastValid.dec_start_odo))) {
      decStartOdo = parseFloat(lastValid.dec_start_odo);
    } else {
      try {
        const rawOdo = (await L.redis([['HGET', 'ambient:baseline', String(L.NOV30_830)]]))[0];
        if (rawOdo != null && !isNaN(parseFloat(rawOdo))) decStartOdo = parseFloat(rawOdo);
      } catch (e) {}
    }
    if (decStartOdo == null) decStartOdo = currentTotalIn;

    dec = +(Math.max(
      0,
      lastValid.dec ? parseFloat(lastValid.dec) : 0,
      (currentTotalIn - decStartOdo) * 25.4
    )).toFixed(1);
  } else {
    // Post December:
    oct = +(Math.max(379.7, lastValid.oct_final ? parseFloat(lastValid.oct_final) : (lastValid.oct ? parseFloat(lastValid.oct) : 0))).toFixed(1);
    nov = +(Math.max(0, lastValid.nov_final ? parseFloat(lastValid.nov_final) : (lastValid.nov ? parseFloat(lastValid.nov) : 0))).toFixed(1);
    dec = +(Math.max(0, lastValid.dec_final ? parseFloat(lastValid.dec_final) : (lastValid.dec ? parseFloat(lastValid.dec) : 0))).toFixed(1);
  }

  const nem = +(oct + nov + dec).toFixed(1);

  const year = +(Math.max(
    790.9,
    lastValid.year ? parseFloat(lastValid.year) : 0,
    yearlyIn != null ? yearlyIn * 25.4 : 0
  )).toFixed(1);

  const month = activeRainMonth === '2026-11' ? nov : (activeRainMonth === '2026-12' ? dec : oct);
  const rate = +((hourlyIn || 0) * 25.4).toFixed(1);

  // Calendar day: preserve across temporary outages, but respect day change:
  const isSameCalDayAsLastValid = lastValid.calDayDate === todayCalDate;
  const calDay = +(
    (dailyIn != null
      ? dailyIn
      : (isSameCalDayAsLastValid && lastValid.calDay != null ? parseFloat(lastValid.calDay) : 0)
    ) * 25.4
  ).toFixed(1);

  // Update last valid in Redis:
  try {
    const redisUpdates = [
      'HSET', 'ambient:last_valid',
      'oct', oct.toFixed(1),
      'nov', nov.toFixed(1),
      'dec', dec.toFixed(1),
      'month', month.toFixed(1),
      'year', year.toFixed(1),
      'calDay', (dailyIn != null ? dailyIn : (isSameCalDayAsLastValid && lastValid.calDay ? parseFloat(lastValid.calDay) : 0)).toFixed(4),
      'calDayDate', todayCalDate,
      'totalIn', currentTotalIn.toFixed(4)
    ];
    if (ws < L.OCT31_830) {
      redisUpdates.push('oct_final', oct.toFixed(1), 'nov_start_odo', currentTotalIn.toFixed(4));
    } else if (ws < L.NOV30_830) {
      redisUpdates.push('nov_final', nov.toFixed(1), 'dec_start_odo', currentTotalIn.toFixed(4));
    } else if (ws < L.DEC31_830) {
      redisUpdates.push('dec_final', dec.toFixed(1));
    }
    await L.redis([redisUpdates]);
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

async function wuStation(s, now, ws, todayCalDate, rainDayStartDate, rainDayEndDate, activeRainMonth) {
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

  // 3. MONTHLY, NEM, AND YEARLY TOTALS (IMD 08:30 AM METEOROLOGICAL MONTHS):
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

  // Extra fallback: if completed day (e.g. Oct 31 or Nov 30) is not yet in dailysummary, check 24h rolling obs (pts):
  if (!completedDaysMap['2026-10-31'] && todayCalDate > '2026-10-31') {
    const pts31 = pts.filter(p => L.istDate(p.t) === '2026-10-31');
    if (pts31.length) {
      completedDaysMap['2026-10-31'] = Math.max(...pts31.map(p => p.v));
    }
  }
  if (!completedDaysMap['2026-11-30'] && todayCalDate > '2026-11-30') {
    const pts30 = pts.filter(p => L.istDate(p.t) === '2026-11-30');
    if (pts30.length) {
      completedDaysMap['2026-11-30'] = Math.max(...pts30.map(p => p.v));
    }
  }

  // Automatically save any new completed days into Redis for permanent storage:
  try {
    const redisSaves = [];
    for (const [k, v] of Object.entries(completedDaysMap)) {
      redisSaves.push(['HSET', 'rain:' + s.id, k, v.toFixed(2)]);
    }
    if (redisSaves.length) await L.redis(redisSaves);
  } catch (e) {}

  // Split completed days across month boundaries per IMD 08:30 AM cutoffs:
  // For Oct 31: rain before 08:30 AM belongs to October; rain after 08:30 AM belongs to November.
  // For Nov 30: rain before 08:30 AM belongs to November; rain after 08:30 AM belongs to December.
  let extraOct = 0;
  let extraNov = 0;
  let extraDec = 0;
  let extraYear = 0;

  let oct31Cutoff = null;
  let nov30Cutoff = null;

  if (completedDaysMap['2026-10-31'] != null) {
    try {
      const rawCut = (await L.redis([
        ['HGET', 'wu:cutoff_830:2026-10-31', s.id],
        ['HGET', 'wu:baseline:' + s.id, String(L.OCT31_830)]
      ])) || [];
      if (rawCut[0] != null && !isNaN(parseFloat(rawCut[0]))) oct31Cutoff = parseFloat(rawCut[0]);
      else if (rawCut[1] != null && !isNaN(parseFloat(rawCut[1]))) oct31Cutoff = parseFloat(rawCut[1]);
    } catch (e) {}
    if (oct31Cutoff == null) oct31Cutoff = KNOWN_BASELINES['2026-10-31']?.[s.id] ?? 0;
  }

  if (completedDaysMap['2026-11-30'] != null) {
    try {
      const rawCut = (await L.redis([
        ['HGET', 'wu:cutoff_830:2026-11-30', s.id],
        ['HGET', 'wu:baseline:' + s.id, String(L.NOV30_830)]
      ])) || [];
      if (rawCut[0] != null && !isNaN(parseFloat(rawCut[0]))) nov30Cutoff = parseFloat(rawCut[0]);
      else if (rawCut[1] != null && !isNaN(parseFloat(rawCut[1]))) nov30Cutoff = parseFloat(rawCut[1]);
    } catch (e) {}
    if (nov30Cutoff == null) nov30Cutoff = KNOWN_BASELINES['2026-11-30']?.[s.id] ?? 0;
  }

  for (const [dayStr, val] of Object.entries(completedDaysMap)) {
    extraYear += val;
    if (dayStr === '2026-10-31') {
      const base = oct31Cutoff != null ? Math.min(val, oct31Cutoff) : val;
      const post = Math.max(0, val - base);
      extraOct += base;
      extraNov += post;
    } else if (dayStr === '2026-11-30') {
      const base = nov30Cutoff != null ? Math.min(val, nov30Cutoff) : val;
      const post = Math.max(0, val - base);
      extraNov += base;
      extraDec += post;
    } else if (dayStr.startsWith('2026-10')) {
      extraOct += val;
    } else if (dayStr.startsWith('2026-11')) {
      extraNov += val;
    } else if (dayStr.startsWith('2026-12')) {
      extraDec += val;
    }
  }

  // Live today's calendar rain is routed according to IMD 08:30 AM rain-day boundaries:
  let liveOct = 0;
  let liveNov = 0;
  let liveDec = 0;

  if (todayCalDate === '2026-10-31') {
    if (ws < L.OCT31_830) {
      liveOct = calMm;
      liveNov = 0;
      liveDec = 0;
    } else {
      // Past 08:30 AM on Oct 31: Pre-8:30 belongs to October, Post-8:30 belongs to November:
      liveOct = p830;
      liveNov = Math.max(0, calMm - p830);
      liveDec = 0;
      try {
        await L.redis([['HSET', 'wu:cutoff_830:2026-10-31', s.id, p830.toFixed(2)]]);
      } catch (e) {}
    }
  } else if (todayCalDate === '2026-11-30') {
    if (ws < L.NOV30_830) {
      liveOct = 0;
      liveNov = calMm;
      liveDec = 0;
    } else {
      // Past 08:30 AM on Nov 30: Pre-8:30 belongs to November, Post-8:30 belongs to December:
      liveOct = 0;
      liveNov = p830;
      liveDec = Math.max(0, calMm - p830);
      try {
        await L.redis([['HSET', 'wu:cutoff_830:2026-11-30', s.id, p830.toFixed(2)]]);
      } catch (e) {}
    }
  } else if (todayCalDate.startsWith('2026-10')) {
    liveOct = calMm;
  } else if (todayCalDate.startsWith('2026-11')) {
    liveNov = calMm;
  } else if (todayCalDate.startsWith('2026-12')) {
    liveDec = calMm;
  }

  const oct = +(hist.octoberTotal + extraOct + liveOct).toFixed(1);
  const nov = +(extraNov + liveNov).toFixed(1);
  const dec = +(extraDec + liveDec).toFixed(1);
  const nem = +(oct + nov + dec).toFixed(1);
  const year = +(hist.yearTotal + extraYear + calMm).toFixed(1);
  const month = activeRainMonth === '2026-11' ? nov : (activeRainMonth === '2026-12' ? dec : oct);

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
  const activeRainMonth = L.rainDayMonth(ws);

  const out = await Promise.all(
    L.STATIONS.map(s => {
      const p = s.amb
        ? ambient(s, now, ws, todayCalDate, rainDayStartDate, rainDayEndDate, activeRainMonth)
        : wuStation(s, now, ws, todayCalDate, rainDayStartDate, rainDayEndDate, activeRainMonth);
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
    rainDayMonth: activeRainMonth,
    windowStart: ws,
    windowEnd: we,
    stations: out
  });
};
