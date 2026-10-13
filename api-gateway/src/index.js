require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');

const services = {
  auth: process.env.AUTH_URL || 'http://127.0.0.1:4002',
  tutor: process.env.TUTOR_URL || 'http://127.0.0.1:4001',
  booking: process.env.BOOKING_URL || 'http://127.0.0.1:4004',
  wallet: process.env.WALLET_URL || 'http://127.0.0.1:4003',
};

function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Sign in first: missing Bearer token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function forwardTo(name) {
  return async (req, res) => {
    const headers = { 'content-type': 'application/json' };
    if (req.user) {
      headers['x-user-id'] = req.user.sub;
      headers['x-user-email'] = req.user.email;
    }
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    const who = req.user ? req.user.email : 'anonymous';
    console.log(`[Gateway] ${req.method} ${req.originalUrl} -> ${name}-service (${who})`);
    try {
      const response = await fetch(services[name] + req.originalUrl, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      res.status(response.status);
      const contentType = response.headers.get('content-type');
      if (contentType) res.set('content-type', contentType);
      return res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.warn(`[Gateway] ${name}-service unavailable: ${error.message}`);
      return res.status(502).json({ error: `${name} service unavailable` });
    }
  };
}

function protectWrites(req, res, next) {
  if (req.method === 'GET') return next();
  return authenticate(req, res, next);
}

const app = express();
app.use(express.json());

app.post('/auth/register', forwardTo('auth'));
app.post('/auth/login', forwardTo('auth'));
app.get('/auth/me', authenticate, forwardTo('auth'));
app.use('/tutors', protectWrites, forwardTo('tutor'));
app.use('/availability', authenticate, forwardTo('booking'));
app.use('/bookings', authenticate, forwardTo('booking'));
app.use('/wallet', authenticate, forwardTo('wallet'));
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
  console.error('[Gateway] request error', error);
  return res.status(500).json({ error: 'Internal server error' });
});

if (!process.env.JWT_SECRET) {
  console.error('[Gateway] JWT_SECRET is required. Add it to api-gateway/.env');
  process.exit(1);
}
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`[Gateway] listening on http://127.0.0.1:${port}`));
