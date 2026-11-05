// Contract compilation/serialization only; no running service or network calls.
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const bookingRequire = createRequire(path.resolve(__dirname, '../booking-service/package.json'));
const loaderRequire = createRequire(bookingRequire.resolve('@grpc/proto-loader'));
const protobuf = loaderRequire('protobufjs');
const root = protobuf.loadSync(path.join(__dirname, 'grpc/booking/v1/availability.proto'));
root.resolveAll();
const svc = root.lookupService('tutor_matcher.booking.v1.AvailabilityService');
assert.deepEqual(Object.keys(svc.methods), ['GetAvailability', 'BatchGetAvailability']);
for (const method of Object.values(svc.methods)) {
  for (const type of [method.resolvedRequestType, method.resolvedResponseType]) {
    const message = type.create({});
    assert.equal(type.verify(message), null);
    type.decode(type.encode(message).finish());
  }
}
const request = root.lookupType('tutor_matcher.booking.v1.GetAvailabilityRequest');
const example = {query: {tutorId: '11111111-1111-4111-8111-111111111111', subjectId: '22222222-2222-4222-8222-222222222222', from: '2026-11-06T00:00:00.000Z', to: '2026-11-07T00:00:00.000Z'}};
assert.equal(request.verify(example), null);
assert.deepEqual(request.toObject(request.decode(request.encode(request.create(example)).finish())), example);
console.log('PASS: protobuf resolves, both RPC types encode/decode, populated availability request round-trips. Semantic bounds are documented; protobuf does not enforce them.');
