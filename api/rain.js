const L = require('./_lib');

async function ambient(s) {
  const base = 'https://lightning.ambientweather.net/';
  const dev = (await (await fetch(base + 'devices?public.slug=' + s.amb)).json()).data[0];
  const ld = dev.lastData; let pts = [];
  try { // best effort: recent history of the public dashboard
    const h = await (await fetch(`${base}device-data?public.slug=${s.amb}&macAddress=${dev.macAddress}&limit=300`)).json();
    pts = (Array.isArray(h) ? h : h.data || []).map(x => ({ t: Math.floor(x.dateutc / 1000), v: (x.dailyrainin || 0) * 25.4 })).sort((a, b) => a.t - b.t);
  } catch (e) {}
  return { name: dev.info && dev.info.name, rate: (ld.hourlyrainin || 0) * 25.4, last: Math.floor(ld.dateutc / 1000), p5: pts, pH: null };
}
async function wuStation(s, full) {
  const o5 = await L.wu('observations/all/1day', s.id);
  const last = o5[o5.length - 1];
  const pH = full ? L.toPts(await L.wu('observations/hourly/7day', s.id)) : null;
  return { rate: last?.metric?.precipRate || 0, last: last?.epoch || 0, p5: L.toPts(o5), pH };
}
async function nameOf(s, d) {
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
  await L.writeDays(s.id, L.toDays(list), first);
  const raw = (await L.redis([['HGETALL', 'rain:' + s.id]]))[0] || {}, h = {};
  // Upstash REST returns HGETALL as a plain object {field:val,...}; some proxies use a flat array.
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) h[raw[i]] = +raw[i + 1];
  } else {
    for (const [k, v] of Object.entries(raw)) h[k] = +v;
  }
  const sum = p => Object.entries(h).filter(([k]) => k.startsWith(p)).reduce((a, [, v]) => a + v, 0);
  const y = todayKey.slice(0, 4), m = +todayKey.slice(5, 7);
  const nem = m >= 10 ? sum(y + '-10') + sum(y + '-11') + sum(y + '-12') : 0;
  const ws = Math.floor((now - 10800) / 86400) * 86400 + 10800, series = [];
  for (let t = ws + 1800; t - 1800 < now && t <= ws + 86400; t += 1800) {
    let c = 0; for (const i of list) { const a = Math.max(i.t0, ws), b = Math.min(i.t1, t); if (b > a) c += i.d * (b - a) / (i.t1 - i.t0); }
    series.push(+c.toFixed(2));
  }
  const r = n => +n.toFixed(1);
  return { id: s.id, name: await nameOf(s, d), rate: r(d.rate), ageMin: Math.round((now - d.last) / 60), today: r(h[todayKey] || 0),
    month: r(sum(todayKey.slice(0, 7))), nem: r(nem), year: r(sum(y)), series };
}
module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000), todayKey = L.key(now), full = req.query.full === '1';
  const out = await Promise.all(L.STATIONS.map(s => one(s, full, now, todayKey).catch(e => ({ id: s.id, name: s.id, error: e.message }))));
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  res.json({ updated: now, todayKey, windowStart: Math.floor((now - 10800) / 86400) * 86400 + 10800, stations: out });
};
