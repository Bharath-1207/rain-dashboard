// Proxy endpoint for daily forecast plots to eliminate CORS and hotlinking restrictions
module.exports = async (req, res) => {
  const rawId = (req.query.id || req.query.p || '').trim();
  if (!rawId || !/^[a-zA-Z0-9_\-\.]+$/.test(rawId)) {
    return res.status(400).send('Invalid plot id');
  }

  // Normalize id: p04 -> plot_04.jpg, 31 -> plot_31.jpg, plot_32 -> plot_32.jpg
  let base = rawId.replace(/\.jpg$/i, '');
  let fileName;
  if (/^p\d{2}$/i.test(base)) {
    fileName = 'plot_' + base.slice(1) + '.jpg';
  } else if (/^\d{1,2}$/.test(base)) {
    fileName = 'plot_' + base.padStart(2, '0') + '.jpg';
  } else if (/^plot_\d{1,2}$/i.test(base)) {
    const num = base.split('_')[1].padStart(2, '0');
    fileName = 'plot_' + num + '.jpg';
  } else {
    fileName = `${base}.jpg`;
  }

  const targetUrl = `https://plots.chennairains.com/daily_plots/${fileName}`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status} for ${fileName}`);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    return res.send(buffer);
  } catch (e) {
    return res.status(502).send('Error fetching plot: ' + e.message);
  }
};
