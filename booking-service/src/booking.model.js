const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  tutorId: { type: String, required: true },
  subjectName: { type: String, required: true },
  slotIds: { type: [String], required: true },
  startsAt: { type: Date, required: true },
  durationMinutes: { type: Number, required: true },
  amount: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ['PAYMENT_DUE', 'CONFIRMED', 'CANCELLED'],
    default: 'PAYMENT_DUE',
  },
  paidAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  refundAmount: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('Booking', bookingSchema);
