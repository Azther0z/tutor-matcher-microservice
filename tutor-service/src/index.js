require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const tutorRoutes = require('./tutor.routes');

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/tutor_db';
  await mongoose.connect(mongoUri);
  console.log(`[Tutor] MongoDB connected: ${mongoose.connection.name}`);

  const app = express();
  app.use(express.json());
  app.use('/tutors', tutorRoutes);
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[Tutor] request error', error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.PORT || 4001);
  app.listen(port, () => console.log(`[Tutor] REST listening on http://127.0.0.1:${port}`));
}

main().catch((error) => {
  console.error('[Tutor] startup failed', error);
  process.exit(1);
});

