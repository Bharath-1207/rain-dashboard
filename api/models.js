// API endpoint for Model Forecasts, 850 hPa Winds, and Multi-Model Rainfall
// Returns current synoptic run dates, available forecast charts, and metadata for ECMWF, AIFS, WeatherNext 3, GFS.

module.exports = async (req, res) => {
  const now = new Date();
  
  // Calculate current synoptic run (00z, 06z, 12z, 18z in UTC)
  const utcHours = now.getUTCHours();
  let runHour = '00z';
  if (utcHours >= 18) runHour = '12z';
  else if (utcHours >= 12) runHour = '06z';
  else if (utcHours >= 6) runHour = '00z';
  else runHour = '18z'; // previous day 18z

  const runDateStr = now.toISOString().slice(0, 10);
  const istDateFormatted = now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  const istTimeFormatted = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Base URL for daily plots
  const PLOTS_BASE = 'https://plots.chennairains.com/daily_plots';
  const vTag = now.toISOString().slice(0, 10).replace(/-/g, '') + '0329';

  const plots = [
    {
      id: 'p04',
      title: 'South India 24-Hour Rainfall Estimate',
      model: 'ECMWF (Ensemble + HRES)',
      category: 'precip24',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_04.jpg?v=${vTag}`,
      desc: 'ECMWF high-resolution (HRES) combined with 51 ensemble members for 24h accumulation.'
    },
    {
      id: 'p05',
      title: 'South India Weighted Multi-Model Blend',
      model: 'Multi-Model Blend',
      category: 'precip24',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_05.jpg?v=${vTag}`,
      desc: 'Optimal weighted blend of ECMWF, GFS, ICON, GEM, and AI models.'
    },
    {
      id: 'p06',
      title: 'South India 24-Hour Rainfall (WeatherNext 3)',
      model: 'WeatherNext 3 (Google DeepMind)',
      category: 'precip24',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_06.jpg?v=${vTag}`,
      desc: 'Google DeepMind AI model forecasting 24h rainfall using direct satellite mosaic ingestion.'
    },
    {
      id: 'p07',
      title: 'Tamil Nadu & Puducherry 24-Hour Rainfall',
      model: 'ECMWF (Ensemble + HRES)',
      category: 'precip24',
      region: 'Tamil Nadu',
      url: `${PLOTS_BASE}/plot_07.jpg?v=${vTag}`,
      desc: 'Regional zoom for Tamil Nadu, Puducherry, and Karaikal coastal districts.'
    },
    {
      id: 'p08',
      title: 'Tamil Nadu & Puducherry Multi-Model Blend',
      model: 'Multi-Model Blend',
      category: 'precip24',
      region: 'Tamil Nadu',
      url: `${PLOTS_BASE}/plot_08.jpg?v=${vTag}`,
      desc: 'High-confidence regional multi-model blend across Tamil Nadu and Puducherry.'
    },
    {
      id: 'p09',
      title: 'Tamil Nadu & Puducherry (WeatherNext 3)',
      model: 'WeatherNext 3 (Google DeepMind)',
      category: 'precip24',
      region: 'Tamil Nadu',
      url: `${PLOTS_BASE}/plot_09.jpg?v=${vTag}`,
      desc: 'Google AI localized 24h precipitation forecast for Tamil Nadu and coastal belt.'
    },
    {
      id: 'p12',
      title: 'South India 7-Day Accumulated Rainfall',
      model: 'ECMWF (Ensemble + HRES)',
      category: 'accum',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_12.jpg?v=${vTag}`,
      desc: 'Total precipitation expected over the next 7 days across South India.'
    },
    {
      id: 'p13',
      title: 'South India 7-Day Multi-Model Blend',
      model: 'Multi-Model Blend',
      category: 'accum',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_13.jpg?v=${vTag}`,
      desc: 'Consensus 7-day cumulative rainfall total from global ensemble models.'
    },
    {
      id: 'p14',
      title: 'South India 7-Day Rainfall (WeatherNext 3)',
      model: 'WeatherNext 3 (Google DeepMind)',
      category: 'accum',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_14.jpg?v=${vTag}`,
      desc: 'Google DeepMind 7-day total precipitation forecast.'
    },
    {
      id: 'p15',
      title: 'Tamil Nadu & Puducherry 7-Day Accumulated Rain',
      model: 'ECMWF (Ensemble + HRES)',
      category: 'accum',
      region: 'Tamil Nadu',
      url: `${PLOTS_BASE}/plot_15.jpg?v=${vTag}`,
      desc: '7-day cumulative total for coastal and interior Tamil Nadu & Puducherry.'
    },
    {
      id: 'p17',
      title: 'Tamil Nadu & Puducherry 7-Day (WeatherNext 3)',
      model: 'WeatherNext 3 (Google DeepMind)',
      category: 'accum',
      region: 'Tamil Nadu',
      url: `${PLOTS_BASE}/plot_17.jpg?v=${vTag}`,
      desc: 'AI 7-day cumulative rainfall total.'
    },
    {
      id: 'p20',
      title: 'South India 14-Day Accumulated Rainfall',
      model: 'ECMWF Extended',
      category: 'accum',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_20.jpg?v=${vTag}`,
      desc: 'Two-week extended range cumulative rainfall estimate.'
    },
    {
      id: 'p31',
      title: '10 m Surface Wind Convergence (South India)',
      model: 'Surface Winds (10m)',
      category: 'wind',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_31.jpg?v=${vTag}`,
      desc: 'Near-surface 10 m wind speeds and convergence lines along the Coromandel coast.'
    },
    {
      id: 'p32',
      title: '850 hPa Wind Speed & Streamlines (South India)',
      model: '850 hPa Level (~1.5 km)',
      category: 'wind',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_32.jpg?v=${vTag}`,
      desc: 'Lower troposphere steering winds at 850 hPa showing easterly waves and Bay circulations.'
    },
    {
      id: 'p33',
      title: '850 hPa Mean Wind Flow (Day 1)',
      model: '850 hPa Mean Wind',
      category: 'wind',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_33.jpg?v=${vTag}`,
      desc: 'Day 1 integrated 850 hPa wind flow vectors and shear zones.'
    },
    {
      id: 'p34',
      title: '500 hPa Mid-Troposphere Mean Wind',
      model: '500 hPa Level (~5.5 km)',
      category: 'wind',
      region: 'South India',
      url: `${PLOTS_BASE}/plot_34.jpg?v=${vTag}`,
      desc: 'Steering flow for deep convection and upper-air troughs.'
    }
  ];

  // Meteologix links specifically for Puducherry & Auroville coordinate sector (79.1° E, 12.2° N)
  const meteologix = {
    area: '791-e-122-n',
    locationName: 'Puducherry & Auroville Sector (79.1° E, 12.2° N)',
    wind850: 'https://meteologix.com/in/model-charts/euro/791-e-122-n/wind-mean-850hpa/',
    precip24h: 'https://meteologix.com/in/model-charts/euro/791-e-122-n/precipitation-24h/',
    accumPrecip: 'https://meteologix.com/in/model-charts/euro/791-e-122-n/precipitation-total/',
    aifsWind850: 'https://meteologix.com/in/model-charts/euro-ai/791-e-122-n/wind-mean-850hpa/',
    gfsWind850: 'https://meteologix.com/in/model-charts/gfs/791-e-122-n/wind-mean-850hpa/'
  };

  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
  res.json({
    updated: now.toISOString(),
    istUpdated: `${istDateFormatted}, ${istTimeFormatted} IST`,
    latestRun: runHour,
    runDate: runDateStr,
    supportedModels: [
      { id: 'ecmwf', name: 'ECMWF IFS (HRES)', type: 'Deterministic', provider: 'ECMWF' },
      { id: 'aifs', name: 'ECMWF AIFS', type: 'Machine Learning', provider: 'ECMWF' },
      { id: 'weathernext', name: 'WeatherNext 3', type: 'Machine Learning', provider: 'Google DeepMind' },
      { id: 'gfs', name: 'GFS', type: 'Deterministic', provider: 'NOAA NCEP' },
      { id: 'eps', name: 'ECMWF EPS', type: 'Ensemble', provider: 'ECMWF' }
    ],
    meteologix,
    plots
  });
};
