const grpc = require('@grpc/grpc-js');
const mongoose = require('mongoose');
const Availability = require('./availability.model');

function fail(callback, code, details) {
  callback({ code, details });
}

function handleDatabaseError(error, callback) {
  console.error('[Booking] database error', error);
  fail(callback, grpc.status.INTERNAL, 'Database operation failed');
}

function validId(id) {
  return mongoose.isValidObjectId(id);
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toSlot(doc) {
  return {
    id: String(doc._id),
    tutorId: doc.tutorId,
    startedAt: doc.startedAt.toISOString(),
    bookingId: doc.bookingId || '',
  };
}

async function CreateSlot(call, callback) {
  const { tutorId, startedAt } = call.request;
  const date = parseDate(startedAt);
  if (!validId(tutorId) || !date) {
    return fail(callback, grpc.status.INVALID_ARGUMENT, 'tutorId must be an ObjectId and startedAt must be an ISO 8601 datetime');
  }
  try {
    const slot = await Availability.create({ tutorId, startedAt: date });
    console.log(`[Booking] CreateSlot ${slot.id} for tutor ${tutorId}`);
    callback(null, toSlot(slot));
  } catch (error) { handleDatabaseError(error, callback); }
}

async function GetAvailability(call, callback) {
  const { tutorId } = call.request;
  if (!validId(tutorId)) return fail(callback, grpc.status.INVALID_ARGUMENT, 'tutorId must be an ObjectId');
  try {
    const docs = await Availability.find({ tutorId }).sort({ startedAt: 1 }).lean();
    console.log(`[Booking] GetAvailability for tutor ${tutorId}: ${docs.length} slot(s)`);
    callback(null, { slots: docs.map(toSlot) });
  } catch (error) { handleDatabaseError(error, callback); }
}

async function UpdateSlot(call, callback) {
  const { id, startedAt, bookingId } = call.request;
  if (!validId(id)) return fail(callback, grpc.status.INVALID_ARGUMENT, 'id must be an ObjectId');
  const changes = {};
  if (startedAt !== undefined) {
    const date = parseDate(startedAt);
    if (!date) return fail(callback, grpc.status.INVALID_ARGUMENT, 'startedAt must be an ISO 8601 datetime');
    changes.startedAt = date;
  }
  if (bookingId !== undefined) changes.bookingId = bookingId || null;
  if (Object.keys(changes).length === 0) return fail(callback, grpc.status.INVALID_ARGUMENT, 'Provide startedAt or bookingId');
  try {
    const slot = await Availability.findByIdAndUpdate(id, changes, { new: true, runValidators: true });
    if (!slot) return fail(callback, grpc.status.NOT_FOUND, 'Slot not found');
    console.log(`[Booking] UpdateSlot ${id}`);
    callback(null, toSlot(slot));
  } catch (error) { handleDatabaseError(error, callback); }
}

async function DeleteSlot(call, callback) {
  const { id } = call.request;
  if (!validId(id)) return fail(callback, grpc.status.INVALID_ARGUMENT, 'id must be an ObjectId');
  try {
    const slot = await Availability.findByIdAndDelete(id);
    if (!slot) return fail(callback, grpc.status.NOT_FOUND, 'Slot not found');
    console.log(`[Booking] DeleteSlot ${id}`);
    callback(null, { deleted: true });
  } catch (error) { handleDatabaseError(error, callback); }
}

module.exports = { CreateSlot, GetAvailability, UpdateSlot, DeleteSlot };

