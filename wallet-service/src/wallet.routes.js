const express = require('express');
const { pool, withTransaction, lockWallet, applyMovement } = require('./db');
const { publish } = require('./events');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUser(req, res, next) {
  const userId = req.get('x-user-id');
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  req.userId = userId;
  next();
}

function toTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    reference: row.reference,
    createdAt: row.created_at,
  };
}

function toTopup(row) {
  return {
    id: row.id,
    amount: row.amount,
    status: row.status,
    promptPayPayload: `MOCK-PROMPTPAY|${row.id}|${row.amount}.00 THB`,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

router.use(requireUser);

router.get('/', async (req, res) => {
  const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.userId]);
  const history = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [req.userId],
  );
  res.json({
    userId: req.userId,
    balance: wallet.rows[0]?.balance ?? 0,
    currency: 'THB',
    transactions: history.rows.map(toTransaction),
  });
});

router.post('/topups', async (req, res) => {
  const amount = req.body?.amount;
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    return res.status(400).json({ error: 'amount must be a whole number of baht between 1 and 100000' });
  }
  const { rows } = await pool.query('INSERT INTO topups (user_id, amount) VALUES ($1, $2) RETURNING *', [req.userId, amount]);
  console.log(`[Wallet] top-up ${rows[0].id} created: ${amount} THB, waiting for payment`);
  res.status(201).json(toTopup(rows[0]));
});

router.post('/topups/:id/confirm', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid top-up id' });
  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [req.params.id]);
    const topup = rows[0];
    if (!topup || topup.user_id !== req.userId) return { status: 404 };
    if (topup.status === 'PAID') {
      const balance = await lockWallet(client, req.userId);
      return { status: 200, topup, balance, alreadyConfirmed: true };
    }
    await lockWallet(client, req.userId);
    const paid = await client.query("UPDATE topups SET status = 'PAID', paid_at = now() WHERE id = $1 RETURNING *", [topup.id]);
    const movement = await applyMovement(client, { userId: req.userId, type: 'TOPUP', amount: topup.amount, reference: topup.id });
    return { status: 200, topup: paid.rows[0], balance: movement.balance_after, alreadyConfirmed: false };
  });
  if (outcome.status === 404) return res.status(404).json({ error: 'Top-up not found' });
  if (outcome.alreadyConfirmed) {
    console.log(`[Wallet] top-up ${outcome.topup.id} already confirmed; balance unchanged at ${outcome.balance} THB`);
  } else {
    console.log(`[Wallet] top-up ${outcome.topup.id} confirmed: +${outcome.topup.amount} THB, balance ${outcome.balance} THB`);
    await publish('wallet.topped_up', {
      userId: req.userId,
      topupId: outcome.topup.id,
      amount: outcome.topup.amount,
      balance: outcome.balance,
    });
  }
  res.json({ ...toTopup(outcome.topup), balance: outcome.balance, alreadyConfirmed: outcome.alreadyConfirmed });
});

module.exports = router;
