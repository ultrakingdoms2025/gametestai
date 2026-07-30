/**
 * Vercel serverless function - POST /api/chat
 * Diagnostic version
 */

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const bodyType = typeof req.body;
  const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
  const playerMessage = req.body && req.body.playerMessage ? req.body.playerMessage : '(missing)';

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    method: req.method,
    bodyType,
    bodyKeys,
    playerMessage,
    env: !!process.env.ANTHROPIC_API_KEY
  }));
}