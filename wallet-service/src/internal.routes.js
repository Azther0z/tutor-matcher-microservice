const express = require('express');
const { withTransaction, lockWallet, applyMovement, findTransaction } = require('./db');

const router = express.Router();

function readMovement(body) {
  const { userId, bookingId, amount } = body || {};
  if (typeof userId !== 'string' || !userId) return null;
  if (typeof bookingId !== 'string' || !bookingId) return null;
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return { userId, bookingId, amount };
}

router.post('/charges', async (req, res) => {
  const input = readMovement(req.body);
  if (!input) return res.status(400).json({ error: 'userId, bookingId and a positive whole amount are required' });
  const outcome = await withTransaction(async (client) => {
    const balance = await lockWallet(client, input.userId);
    const existing = await findTransaction(client, 'PAYMENT', input.bookingId);
    if (existing) return { status: 200, transaction: existing, duplicate: true };
    if (balance < input.amount) return { status: 402, balance };
    const transaction = await applyMovement(client, {
      userId: input.userId, type: 'PAYMENT', amount: -input.amount, reference: input.bookingId,
    });
    return { status: 201, transaction, duplicate: false };
  });
  if (outcome.status === 402) {
    console.log(`[Wallet] charge for booking ${input.bookingId} declined: balance ${outcome.balance} THB < ${input.amount} THB`);
    return res.status(402).json({ error: 'Insufficient balance', balance: outcome.balance, required: input.amount });
  }
  const verb = outcome.duplicate ? 'already charged' : `charged ${input.amount} THB`;
  console.log(`[Wallet] booking ${input.bookingId} ${verb}; balance ${outcome.transaction.balance_after} THB`);
  return res.status(outcome.status).json({
    transactionId: outcome.transaction.id,
    balance: outcome.transaction.balance_after,
    duplicate: outcome.duplicate,
  });
});

router.post('/refunds', async (req, res) => {
  const input = readMovement(req.body);
  if (!input) return res.status(400).json({ error: 'userId, bookingId and a positive whole amount are required' });
  const outcome = await withTransaction(async (client) => {
    await lockWallet(client, input.userId);
    const payment = await findTransaction(client, 'PAYMENT', input.bookingId);
    if (!payment || payment.user_id !== input.userId) return { status: 409 };
    if (input.amount > -payment.amount) return { status: 400 };
    const existing = await findTransaction(client, 'REFUND', input.bookingId);
    if (existing) return { status: 200, transaction: existing, duplicate: true };
    const transaction = await applyMovement(client, {
      userId: input.userId, type: 'REFUND', amount: input.amount, reference: input.bookingId,
    });
    return { status: 201, transaction, duplicate: false };
  });
  if (outcome.status === 409) return res.status(409).json({ error: 'No payment found for this booking' });
  if (outcome.status === 400) return res.status(400).json({ error: 'Refund is larger than the payment' });
  const verb = outcome.duplicate ? 'already refunded' : `refunded ${input.amount} THB`;
  console.log(`[Wallet] booking ${input.bookingId} ${verb}; balance ${outcome.transaction.balance_after} THB`);
  return res.status(outcome.status).json({
    transactionId: outcome.transaction.id,
    balance: outcome.transaction.balance_after,
    duplicate: outcome.duplicate,
  });
});

module.exports = router;
