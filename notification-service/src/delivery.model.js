const mongoose = require('mongoose');

const deliverySchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  recipients: { type: [String], default: [] },
  message: { type: String, required: true },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('Delivery', deliverySchema);
