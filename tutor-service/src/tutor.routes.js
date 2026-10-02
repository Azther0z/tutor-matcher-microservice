const express = require('express');
const mongoose = require('mongoose');
const Tutor = require('./tutor.model');
const { getAvailability } = require('./booking.client');

const router = express.Router();
const editable = ['firstName', 'lastName', 'email', 'bio', 'avatarUrl', 'introVideoUrl', 'status', 'subjects'];

function fields(body) {
  return Object.fromEntries(editable.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
}

function validId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid tutor id' });
  next();
}

function handleError(error, res) {
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ error: error.message });
  }
  if (error.code === 11000) return res.status(409).json({ error: 'Email already exists' });
  console.error('[Tutor] database error', error);
  return res.status(500).json({ error: 'Internal server error' });
}

router.post('/', async (req, res) => {
  try {
    const tutor = await Tutor.create(fields(req.body || {}));
    res.status(201).json(tutor);
  } catch (error) { handleError(error, res); }
});

router.get('/:id', validId, async (req, res) => {
  try {
    const tutor = await Tutor.findById(req.params.id).lean();
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
    console.log(`[Tutor] GET ${req.params.id}; calling Booking.GetAvailability`);
    try {
      const availability = await getAvailability(req.params.id);
      return res.json({ ...tutor, availability, availabilityUnavailable: false });
    } catch (error) {
      console.warn(`[Tutor] Booking unavailable: ${error.message}`);
      return res.json({ ...tutor, availability: [], availabilityUnavailable: true });
    }
  } catch (error) { return handleError(error, res); }
});

router.put('/:id', validId, async (req, res) => {
  try {
    const changes = fields(req.body || {});
    if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'No editable fields provided' });
    const tutor = await Tutor.findById(req.params.id);
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
    tutor.set(changes);
    await tutor.save();
    return res.json(tutor);
  } catch (error) { return handleError(error, res); }
});

router.delete('/:id', validId, async (req, res) => {
  try {
    const tutor = await Tutor.findByIdAndDelete(req.params.id);
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
    return res.status(204).end();
  } catch (error) { return handleError(error, res); }
});

module.exports = router;

