let handleRequest;
let loadError = null;
try {
  ({ handleRequest } = require('../server'));
} catch (e) {
  loadError = e;
}

module.exports = async (req, res) => {
  if (loadError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: 'Server module failed to load',
      message: loadError.message,
      stack: (loadError.stack || '').split('\n').slice(0, 8),
      node: process.version,
    }));
  }
  try {
    return await handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        error: 'Handler threw',
        message: e.message,
        stack: (e.stack || '').split('\n').slice(0, 8),
        node: process.version,
      }));
    }
  }
};
