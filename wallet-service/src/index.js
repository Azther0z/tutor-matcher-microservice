require('dotenv').config();
const express = require('express');
const { migrate } = require('./db');
const walletRoutes = require('./wallet.routes');
const internalRoutes = require('./internal.routes');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Add it to wallet-service/.env');
  await migrate();
  console.log('[Wallet] PostgreSQL connected: wallet_db');

  const app = express();
  app.use(express.json());
  app.use('/wallet', walletRoutes);
  app.use('/internal', internalRoutes);
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[Wallet] request error', error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.PORT || 4003);
  app.listen(port, () => console.log(`[Wallet] REST listening on http://127.0.0.1:${port}`));
}

main().catch((error) => {
  console.error('[Wallet] startup failed', error);
  process.exit(1);
});
