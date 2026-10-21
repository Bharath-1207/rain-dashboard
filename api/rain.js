const L = require('./_lib');

async function ambient(s) {
  const base = 'https://lightning.ambientweather.net/';
  const dev = (await (await fetch(base + 'devices?public.slug=' + s.amb)).json()).data[0];
  const ld = dev.lastData || {};
  return { name: dev.info && dev.info.name, rate: (ld.hourlyrainin || 0) * 25.4, last: Math.floor((ld.dateutc || Date.now()) / 1000), ld };
}

async function wuStation(s) {
  // Use dailysummary/7day for accurate calendar-day totals (no double-counting)
  const [sumRes, curRes] = await Promise.all([
    L.wu('dailysummary/7day', s.id),        // last 7 calendar-day summaries
    L.wu('observations/current', s.id).catch(() => [])
  ]);
  // dailysummary returns obs[] just like other endpoints
  const cur = curRes[0];
  const summaries = sumRes; // each item: { epoch, metric: { precipTotal, precipRate }, obsTimeLocal }
  const today = summaries[summaries.length - 1]; // most recent calendar day
  return {
    rate: cur?.metric?.precipRate || today?.metric?.precipRate || 0,
    last: cur?.epoch || today?.epoch || 0,
    summaries,
    todayCalendarMm: today?.metric?.precipTotal || 0
  };
}

async function nameOf(s) {
  return s.name || s.id;
}

async function one(s, now, todayKey) {
  const ws = Math.floor((now - 10800) / 86400) * 86400 + 10800; // 08:30 IST window start epoch

  if (s.amb) {
    // === AMBIENT WEATHER ===
    const d = await ambient(s);
    const ld = d.ld;
    const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;

    // Today: Ambient dailyrainin resets at midnight. Rain in current 8:30 IST window:
    // only count if lastRain is within the current window (>= ws)
    let todayMm = lr >= ws ? (ld.dailyrainin || 0) * 25.4 : 0;

    const ambMonth = (ld.monthlyrainin || 0) * 25.4;
    const ambYear = (ld.yearlyrainin || 0) * 25.4;

    // Save today to Redis for historical accumulation
    if (todayMm > 0) {
      try { await L.redis([['HSET', 'rain:' + s.id, todayKey, todayMm.toFixed(2)]]); } catch (e) {}
    }

    const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {};
    const h = {};
    if (Array.isArray(raw)) { for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1]; }
    else { for (const [k, v] of Object.entries(raw)) h[k] = +v; }
    const sum = p => Object.entries(h).filter(([k]) => k.startsWith(p)).reduce((a, [, v]) => a + v, 0);
    const y = todayKey.slice(0, 4), m = +todayKey.slice(5, 7);

    let month = Math.max(sum(todayKey.slice(0, 7)), ambMonth);
    let year = Math.max(sum(y), ambYear);
    let nem = m >= 10 ? Math.max(sum(y + '-10') + sum(y + '-11') + sum(y + '-12'), ambMonth) : 0;

    const series = new Array(48).fill(0);
    if (lr >= ws && todayMm > 0) {
      // Approximate: fill from lastRain time onwards
      for (let i = 0; i < 48; i++) {
        const t = ws + (i + 1) * 1800;
        if (t >= lr) series[i] = +todayMm.toFixed(2);
      }
    }

    const r = n => +n.toFixed(1);
    return { id: s.id, name: await nameOf(s), rate: r(d.rate), ageMin: Math.round((now - d.last) / 60),
      today: r(todayMm), month: r(month), nem: r(nem), year: r(year), series };
  }

  // === WU WEATHER UNDERGROUND ===
  const d = await wuStation(s);
  const { summaries, todayCalendarMm } = d;

  // WU precipTotal resets at midnight IST (local calendar midnight).
  // "Today" in our 8:30 IST window = rain that fell SINCE the current window start (8:30 IST).
  // Since WU calendar-day = midnight IST to midnight IST, and our window = 8:30 IST to 8:30 IST:
  // We need 5-min observations to know how much fell AFTER 8:30 IST today.
  // Quick approach: get current obs and subtract baseline at window start.
  let todayMm = 0;
  try {
    const o5 = await L.wu('observations/all/1day', s.id);
    const withPrecip = o5.filter(o => o.metric && o.metric.precipTotal != null);
    if (withPrecip.length > 0) {
      // Find baseline: last obs BEFORE window start (= precipTotal value at 8:30 IST)
      const beforeWs = withPrecip.filter(o => o.epoch < ws);
      const baseline = beforeWs.length > 0 ? beforeWs[beforeWs.length - 1].metric.precipTotal : withPrecip[0].metric.precipTotal;
      const current = withPrecip[withPrecip.length - 1].metric.precipTotal;
      todayMm = Math.max(0, current - baseline);
    }
  } catch (e) {
    // Fallback: nothing since 8:30am yet
    todayMm = 0;
  }

  // Write today's value to Redis
  if (todayMm > 0) {
    try { await L.redis([['HSET', 'rain:' + s.id, todayKey, todayMm.toFixed(2)]]); } catch (e) {}
  }

  // For yesterday's key (the calendar day that ended at 8:30 IST today), write its value too.
  // Yesterday's rain-day key (closing IST date = today) already contains ALL rain from yesterday 8:30am to today 8:30am.
  // That = yesterday's calendar day total + any rain from midnight to 8:30am today.
  // Since the WU dailysummary for yesterday = midnight-to-midnight total:
  // yesterday rain-day total = yesterdayCalendarDay + todayCalendarMm (rain midnight to 8:30am this morning)
  const prevKey = L.key(ws - 1); // the rain-day that just ended at 8:30am today
  const prevCalendarDay = summaries.length >= 2 ? summaries[summaries.length - 2] : null;
  if (prevCalendarDay && prevKey) {
    // yesterday rain-day = yesterdayCalendar total (8:30 IST prev day to midnight) + todayCalendarDay's midnight-to-8:30am rain
    // But we don't have that split directly. Best approximation: use the dailysummary for yesterday as backfill.
    // The calendar day total IS a good approximation since most rain is contained in one calendar day.
    // We'll use both: yesterday calendar total + today calendar total up to 8:30am
    // Since WU resets at midnight, the rain from midnight to 8:30am is in todayCalendarMm.
    // So prevKey total = prevCalendarDay.metric.precipTotal + todayCalendarMm (rain midnight->8:30am)
    // But todayCalendarMm IS the full calendar day total, so we need to subtract what fell AFTER 8:30am.
    // Actually simpler: prevKey = prevCalendarDay.metric.precipTotal + (todayCalendarMm - todayMm)
    const earlyMorningMm = todayCalendarMm - todayMm; // rain from midnight to 8:30am today
    const prevKeyTotal = (prevCalendarDay.metric?.precipTotal || 0) + Math.max(0, earlyMorningMm);
    if (prevKeyTotal > 0) {
      try { await L.redis([['HSET', 'rain:' + s.id, prevKey, prevKeyTotal.toFixed(2)]]); } catch (e) {}
    }
  }

  // Read all Redis data for monthly/yearly sums
  const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {};
  const h = {};
  if (Array.isArray(raw)) { for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1]; }
  else { for (const [k, v] of Object.entries(raw)) h[k] = +v; }
  // Override today's key in memory with fresh live value
  if (todayMm > 0) h[todayKey] = todayMm;

  const sum = p => Object.entries(h).filter(([k]) => k.startsWith(p)).reduce((a, [, v]) => a + v, 0);
  const y = todayKey.slice(0, 4), m = +todayKey.slice(5, 7);
  let month = sum(todayKey.slice(0, 7));
  let year = sum(y);
  let nem = m >= 10 ? sum(y + '-10') + sum(y + '-11') + sum(y + '-12') : 0;

  // Build 24h series using 5-min obs
  const series = new Array(48).fill(0);
  try {
    const o5full = await L.wu('observations/all/1day', s.id);
    const withPrecip = o5full.filter(o => o.metric && o.metric.precipTotal != null && o.epoch >= ws);
    if (withPrecip.length >= 2) {
      const baseline = withPrecip[0].metric.precipTotal;
      for (let i = 0; i < 48; i++) {
        const t = ws + (i + 1) * 1800;
        const obsAtT = withPrecip.filter(o => o.epoch <= t);
        if (obsAtT.length > 0) {
          const val = Math.max(0, obsAtT[obsAtT.length - 1].metric.precipTotal - baseline);
          series[i] = +val.toFixed(2);
        }
      }
    } else if (todayMm > 0) {
      series.fill(+todayMm.toFixed(2));
    }
  } catch (e) {}

  const r = n => +n.toFixed(1);
  return { id: s.id, name: await nameOf(s), rate: r(d.rate), ageMin: Math.round((now - d.last) / 60),
    today: r(todayMm), month: r(month), nem: r(nem), year: r(year), series };
}

module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000), todayKey = L.key(now);
  const out = await Promise.all(L.STATIONS.map(s => one(s, now, todayKey).catch(e => ({ id: s.id, name: s.name || s.id, error: e.message }))));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.json({ updated: now, todayKey, windowStart: Math.floor((now - 10800) / 86400) * 86400 + 10800, stations: out });
};
