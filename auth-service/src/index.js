require('dotenv').config();
const express = require('express');
const { migrate } = require('./db');
const authRoutes = require('./auth.routes');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Add it to auth-service/.env');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required. Add it to auth-service/.env');
  await migrate();
  console.log('[Auth] PostgreSQL connected: auth_db');

  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[Auth] request error', error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.PORT || 4002);
  app.listen(port, () => console.log(`[Auth] REST listening on http://127.0.0.1:${port}`));
}

main().catch((error) => {
  console.error('[Auth] startup failed', error);
  process.exit(1);
});
