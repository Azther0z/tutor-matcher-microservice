const mongoose = require('mongoose');

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  hourlyRate: { type: Number, required: true, min: 0 },
}, { _id: false });

const tutorSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
  bio: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  introVideoUrl: { type: String, default: '' },
  status: {
    type: String,
    enum: ['PENDING', 'UNPUBLISHED', 'PUBLISHED', 'REJECTED'],
    default: 'PENDING',
  },
  subjects: { type: [subjectSchema], default: [] },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('Tutor', tutorSchema);

