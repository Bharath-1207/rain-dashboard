const L = require('./_lib');

async function ambient(s) {
  const base = 'https://lightning.ambientweather.net/';
  const dev = (await (await fetch(base + 'devices?public.slug=' + s.amb)).json()).data[0];
  const ld = dev.lastData || {}; let pts = [];
  try { // best effort: recent history of the public dashboard
    const h = await (await fetch(`${base}device-data?public.slug=${s.amb}&macAddress=${dev.macAddress}&limit=300`)).json();
    pts = (Array.isArray(h) ? h : h.data || []).map(x => ({ t: Math.floor(x.dateutc / 1000), v: (x.dailyrainin || 0) * 25.4 })).sort((a, b) => a.t - b.t);
  } catch (e) {}
  return { name: dev.info && dev.info.name, rate: (ld.hourlyrainin || 0) * 25.4, last: Math.floor((ld.dateutc || Date.now()) / 1000), p5: pts, pH: null, ld };
}
async function wuStation(s, full) {
  const [o5, cur] = await Promise.all([
    L.wu('observations/all/1day', s.id),
    L.wu('observations/current', s.id).catch(() => [])
  ]);
  const c = cur[0];
  const lastAll = o5[o5.length - 1];
  if (c && c.epoch && (!lastAll || c.epoch > lastAll.epoch)) {
    o5.push(c);
  }
  const last = c || lastAll;
  const pH = full ? L.toPts(await L.wu('observations/hourly/7day', s.id)) : null;
  return { rate: last?.metric?.precipRate || 0, last: last?.epoch || 0, p5: L.toPts(o5), pH };
}
async function nameOf(s, d) {
  if (s.name) return s.name;
  if (d.name) return d.name;
  try {
    const c = (await L.redis([['HGET', 'names', s.id]]))[0]; if (c) return c;
    const n = (await L.wu('observations/current', s.id))[0]?.neighborhood;
    if (n) { await L.redis([['HSET', 'names', s.id, n]]); return n; }
  } catch (e) {}
  return s.id;
}
async function one(s, full, now, todayKey) {
  const d = s.amb ? await ambient(s) : await wuStation(s, full);
  let list = L.incs(d.p5), first = d.p5[0]?.t ?? Infinity;
  if (d.pH && d.pH.length) { const cut = first; list = L.incs(d.pH).filter(i => i.t1 <= cut).concat(list); first = Math.min(first, d.pH[0].t); }
  if (list.length) await L.writeDays(s.id, L.toDays(list), first);

  const ws = Math.floor((now - 10800) / 86400) * 86400 + 10800; // 08:30 IST window start epoch
  const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {}, h = {};
  // Upstash REST returns HGETALL as a plain object {field:val,...}; some proxies use a flat array.
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1];
  } else {
    for (const [k, v] of Object.entries(raw)) h[k] = +v;
  }
  const sum = p => Object.entries(h).filter(([k]) => k.startsWith(p)).reduce((a, [, v]) => a + v, 0);
  const y = todayKey.slice(0, 4), m = +todayKey.slice(5, 7);
  let nem = m >= 10 ? sum(y + '-10') + sum(y + '-11') + sum(y + '-12') : 0;
  let year = sum(y);
  let month = sum(todayKey.slice(0, 7));
  let todayVal = h[todayKey] || 0;

  const ld = d.ld;
  if (ld) {
    const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : 0;
    // Ambient hardware dailyrainin resets at midnight, so we verify if rain occurred within current 8:30 AM window:
    if (lr >= ws) {
      const ambToday = (ld.dailyrainin || 0) * 25.4;
      todayVal = Math.max(todayVal, ambToday);
      try { await L.redis([['HSET', 'rain:' + s.id, todayKey, todayVal.toFixed(2)]]); } catch (e) {}
    } else {
      // Last rain was before 8:30 AM (in the previous day's window), so current 8:30 AM window is strictly 0 mm
      todayVal = 0;
    }

    const ambMonth = (ld.monthlyrainin || 0) * 25.4;
    const ambYear = (ld.yearlyrainin || 0) * 25.4;
    month = Math.max(month, ambMonth);
    year = Math.max(year, ambYear);
    if (m >= 10) nem = Math.max(nem, ambMonth);
  }

  const series = [];
  for (let t = ws + 1800; t - 1800 < now && t <= ws + 86400; t += 1800) {
    let c = 0;
    if (list.length) {
      for (const i of list) { const a = Math.max(i.t0, ws), b = Math.min(i.t1, t); if (b > a) c += i.d * (b - a) / (i.t1 - i.t0); }
    } else if (ld && todayVal > 0) {
      const lr = ld.lastRain ? Math.floor(ld.lastRain / 1000) : ws + 3600;
      if (t >= lr) c = todayVal;
    }
    series.push(+c.toFixed(2));
  }
  const r = n => +n.toFixed(1);
  return { id: s.id, name: await nameOf(s, d), rate: r(d.rate), ageMin: Math.round((now - d.last) / 60), today: r(todayVal),
    month: r(month), nem: r(nem), year: r(year), series };
}
module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000), todayKey = L.key(now), full = req.query.full === '1';
  const out = await Promise.all(L.STATIONS.map(s => one(s, full, now, todayKey).catch(e => ({ id: s.id, name: s.id, error: e.message }))));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.json({ updated: now, todayKey, windowStart: Math.floor((now - 10800) / 86400) * 86400 + 10800, stations: out });
};
