const mongoose = require('mongoose');

const availabilitySchema = new mongoose.Schema({
  tutorId: { type: String, required: true, index: true },
  startedAt: { type: Date, required: true },
  bookingId: { type: String, default: null },
}, { timestamps: true, versionKey: false });

availabilitySchema.index({ tutorId: 1, startedAt: 1 });

module.exports = mongoose.model('Availability', availabilitySchema);

