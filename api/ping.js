// Minimal diagnostics endpoint that avoids loading server.js.
module.exports = (req, res) => {
  let serverLoad = 'ok';
  try {
    require('../server');
  } catch (e) {
    serverLoad = (e && e.stack) || String(e);
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    hasSupabaseKey: !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY),
    serverLoad,
  }));
};
