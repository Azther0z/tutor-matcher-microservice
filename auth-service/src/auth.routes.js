const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { publish } = require('./events');

const router = express.Router();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
}

router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (typeof email !== 'string' || !EMAIL.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (typeof displayName !== 'string' || !displayName.trim()) return res.status(400).json({ error: 'displayName is required' });
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *',
      [email.trim().toLowerCase(), passwordHash, displayName.trim()],
    );
    const user = toUser(rows[0]);
    console.log(`[Auth] registered ${user.email}`);
    await publish('user.registered', { userId: user.id, email: user.email });
    return res.status(201).json({ user, token: issueToken(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw error;
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'email and password are required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const user = toUser(row);
  console.log(`[Auth] login ${user.email}`);
  return res.json({ user, token: issueToken(user) });
});

router.get('/me', async (req, res) => {
  const userId = req.get('x-user-id');
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.json(toUser(rows[0]));
});

module.exports = router;
