const express = require('express');
const mongoose = require('mongoose');
const Availability = require('./availability.model');
const Booking = require('./booking.model');
const { getTutor, chargeLessonPayment, refundBooking } = require('./services.client');
const { publish } = require('./events');

const SLOT_MINUTES = 30;
const FULL_REFUND_HOURS = 24;

const availabilityRouter = express.Router();
const bookingRouter = express.Router();

function requireUser(req, res, next) {
  const userId = req.get('x-user-id');
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  req.userId = userId;
  next();
}

function validId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid booking id' });
  next();
}

async function loadOwnBooking(req, res) {
  const booking = await Booking.findById(req.params.id);
  if (!booking || booking.studentId !== req.userId) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  return booking;
}

function refundFor(booking, now = new Date()) {
  const hoursLeft = (booking.startsAt.getTime() - now.getTime()) / 3600000;
  return hoursLeft >= FULL_REFUND_HOURS ? booking.amount : Math.floor(booking.amount / 2);
}

function eventData(booking) {
  return {
    bookingId: String(booking._id),
    studentId: booking.studentId,
    tutorId: booking.tutorId,
    subjectName: booking.subjectName,
    startsAt: booking.startsAt.toISOString(),
    amount: booking.amount,
  };
}

availabilityRouter.use(requireUser);

availabilityRouter.post('/', async (req, res) => {
  const { tutorId, startedAt } = req.body || {};
  const date = typeof startedAt === 'string' ? new Date(startedAt) : null;
  if (!mongoose.isValidObjectId(tutorId) || !date || Number.isNaN(date.getTime())) {
    return res.status(400).json({ error: 'tutorId must be an ObjectId and startedAt must be an ISO 8601 datetime' });
  }
  const slot = await Availability.create({ tutorId, startedAt: date });
  console.log(`[Booking] opened slot ${slot.id} for tutor ${tutorId} at ${date.toISOString()}`);
  res.status(201).json({ id: slot.id, tutorId, startedAt: date.toISOString(), bookingId: null });
});

bookingRouter.use(requireUser);

bookingRouter.get('/', async (req, res) => {
  const bookings = await Booking.find({ studentId: req.userId }).sort({ startsAt: 1 }).lean();
  res.json(bookings);
});

bookingRouter.get('/:id', validId, async (req, res) => {
  const booking = await loadOwnBooking(req, res);
  if (booking) res.json(booking);
});

bookingRouter.post('/', async (req, res) => {
  const { tutorId, subjectName, slotIds } = req.body || {};
  if (!mongoose.isValidObjectId(tutorId) || typeof subjectName !== 'string' || !Array.isArray(slotIds)
    || slotIds.length === 0 || !slotIds.every((id) => mongoose.isValidObjectId(id))
    || new Set(slotIds).size !== slotIds.length) {
    return res.status(400).json({ error: 'tutorId, subjectName and a list of distinct slotIds are required' });
  }

  const tutor = await getTutor(tutorId).catch(() => null);
  if (!tutor) return res.status(503).json({ error: 'Tutor service unavailable' });
  if (tutor.status === 404) return res.status(404).json({ error: 'Tutor not found' });
  if (tutor.status !== 200) return res.status(502).json({ error: 'Tutor service error' });
  if (tutor.body.status !== 'PUBLISHED') return res.status(409).json({ error: 'Tutor is not accepting bookings' });
  const subject = (tutor.body.subjects || []).find((item) => item.name === subjectName);
  if (!subject) return res.status(404).json({ error: 'Tutor does not teach this subject' });

  const slots = await Availability.find({ _id: { $in: slotIds } }).sort({ startedAt: 1 });
  if (slots.length !== slotIds.length || slots.some((slot) => slot.tutorId !== tutorId)) {
    return res.status(404).json({ error: 'One or more slots do not belong to this tutor' });
  }
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i].startedAt - slots[i - 1].startedAt !== SLOT_MINUTES * 60000) {
      return res.status(400).json({ error: 'Slots must be back-to-back 30-minute slots' });
    }
  }

  const booking = new Booking({
    studentId: req.userId,
    tutorId,
    subjectName,
    slotIds: slots.map((slot) => slot.id),
    startsAt: slots[0].startedAt,
    durationMinutes: slots.length * SLOT_MINUTES,
    amount: Math.round((slots.length * subject.hourlyRate) / 2),
  });
  const held = [];
  for (const slot of slots) {
    const updated = await Availability.findOneAndUpdate(
      { _id: slot._id, bookingId: null },
      { bookingId: String(booking._id) },
    );
    if (!updated) {
      await Availability.updateMany({ _id: { $in: held } }, { bookingId: null });
      return res.status(409).json({ error: 'A selected slot is no longer available' });
    }
    held.push(slot._id);
  }
  await booking.save();
  console.log(`[Booking] booking ${booking.id} created: ${subjectName}, ${booking.durationMinutes} min, ${booking.amount} THB, payment due`);
  res.status(201).json(booking);
});

bookingRouter.post('/:id/pay', validId, async (req, res) => {
  const booking = await loadOwnBooking(req, res);
  if (!booking) return;
  if (booking.status === 'CONFIRMED') return res.json(booking);
  if (booking.status !== 'PAYMENT_DUE') return res.status(409).json({ error: `Booking is ${booking.status}` });

  const charge = await chargeLessonPayment({
    userId: booking.studentId, bookingId: booking.id, amount: booking.amount,
  }).catch(() => null);
  if (!charge) return res.status(503).json({ error: 'Wallet service unavailable; booking is still payment due' });
  if (charge.status === 402) return res.status(402).json({ ...charge.body, bookingId: booking.id });
  if (charge.status !== 200 && charge.status !== 201) return res.status(502).json({ error: 'Wallet service error' });

  booking.status = 'CONFIRMED';
  booking.paidAt = new Date();
  await booking.save();
  console.log(`[Booking] booking ${booking.id} paid and confirmed; wallet balance ${charge.body.balance} THB`);
  await publish('booking.confirmed', eventData(booking));
  res.json({ ...booking.toJSON(), walletBalance: charge.body.balance });
});

bookingRouter.post('/:id/cancel', validId, async (req, res) => {
  const booking = await loadOwnBooking(req, res);
  if (!booking) return;
  if (booking.status === 'CANCELLED') return res.json(booking);

  let walletBalance = null;
  let refundAmount = 0;
  if (booking.status === 'CONFIRMED') {
    refundAmount = refundFor(booking);
    if (refundAmount > 0) {
      const refund = await refundBooking({
        userId: booking.studentId, bookingId: booking.id, amount: refundAmount,
      }).catch(() => null);
      if (!refund) return res.status(503).json({ error: 'Wallet service unavailable; booking was not cancelled' });
      if (refund.status !== 200 && refund.status !== 201) return res.status(502).json({ error: 'Refund failed' });
      walletBalance = refund.body.balance;
    }
  }

  await Availability.updateMany({ bookingId: booking.id }, { bookingId: null });
  booking.status = 'CANCELLED';
  booking.cancelledAt = new Date();
  booking.refundAmount = refundAmount;
  await booking.save();
  console.log(`[Booking] booking ${booking.id} cancelled; refund ${refundAmount} THB; slots released`);
  await publish('booking.cancelled', { ...eventData(booking), refundAmount });
  res.json({ ...booking.toJSON(), walletBalance });
});

module.exports = { availabilityRouter, bookingRouter };
