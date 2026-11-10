// Offline contract compilation and codec checks. No target service or network calls.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const bookingRequire = createRequire(path.resolve(__dirname, '../services/booking-service/package.json'));
const loaderRequire = createRequire(bookingRequire.resolve('@grpc/proto-loader'));
const protobuf = loaderRequire('protobufjs');
const protoLoader = bookingRequire('@grpc/proto-loader');
const grpc = bookingRequire('@grpc/grpc-js');
const base = path.join(__dirname, 'grpc');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = read(path.join(base, 'operations.v1.json'));
const fixtures = read(path.join(base, 'examples.v1.json'));
const files = [...new Set(manifest.operations.map(op => op.proto))];
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => path.resolve(base, target);
root.loadSync(files);
root.resolveAll();
const loaded = protoLoader.loadSync(files.map(file => path.join(base, file)), {
  includeDirs: [base], keepCase: false, defaults: false, enums: String, longs: String, oneofs: true,
});

function resolve(schema, file) {
  if (schema.$ref) {
    const [name, pointer] = schema.$ref.split('#');
    const next = name ? path.resolve(path.dirname(file), name) : file;
    let value = read(next);
    for (const key of pointer.replace(/^\//, '').split('/')) value = value[key.replaceAll('~1','/').replaceAll('~0','~')];
    return resolve(value, next);
  }
  if (schema.anyOf) return resolve(schema.anyOf.find(value => value.type !== 'null'), file);
  if (schema.allOf && !schema.properties) return resolve(schema.allOf[0], file);
  return [schema, file];
}

// A contract-checking normalization example, not a running application adapter.
// Preserve scalar presence. Materialize nullable fields and empty repeated fields.
function normalize(value, schema, file) {
  [schema, file] = resolve(schema, file);
  if (value === null) return null;
  if (schema.type === 'object') {
    const result = {};
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value || {}, key)) {
        result[key] = normalize(value[key], child, file);
      } else if (schema.required?.includes(key)) {
        if (child.anyOf?.some(part => part.type === 'null')) result[key] = null;
        else if (resolve(child, file)[0].type === 'array') result[key] = [];
      }
    }
    return result;
  }
  if (schema.type === 'array') return (value || []).map(item => normalize(item, schema.items, file));
  if (schema.type === 'integer') {
    const number = Number(value);
    assert(Number.isSafeInteger(number), 'uint64 count is outside the JSON safe integer range');
    return number;
  }
  return value;
}

function schemaFor(reference) {
  const [name, pointer] = reference.split('#');
  return [{$ref:'#' + pointer}, path.resolve(base, name)];
}

const shapeSeen = new Set();
function assertWireShape(type, schema, file) {
  [schema, file] = resolve(schema, file);
  const identity = type.fullName + JSON.stringify(schema);
  if (shapeSeen.has(identity)) return;
  shapeSeen.add(identity);
  assert.deepEqual(Object.keys(type.fields).sort(), Object.keys(schema.properties).sort(), type.fullName + ' field/schema drift');
  for (const [name, original] of Object.entries(schema.properties)) {
    const field = type.fields[name];
    let [value, source] = resolve(original, file);
    if (field.map) {
      assert.equal(value.type, 'object');
      assert.equal(field.keyType, 'string');
      assert.equal(field.type, 'uint64');
      continue;
    }
    if (field.repeated) {
      assert.equal(value.type, 'array');
      [value, source] = resolve(value.items, source);
    }
    if (field.resolvedType instanceof protobuf.Type) {
      assert.equal(value.type, 'object');
      assertWireShape(field.resolvedType, value, source);
    } else if (field.resolvedType instanceof protobuf.Enum) {
      assert.deepEqual(Object.keys(field.resolvedType.values).filter(key => !key.endsWith('_UNSPECIFIED')).sort(), value.enum.slice().sort());
      if (!field.repeated) assert(field.partOf, type.fullName + '.' + name + ' lacks explicit presence');
    } else {
      const jsonType = value.type || (Object.hasOwn(value, 'const') ? typeof value.const : undefined);
      const permitted = {string:['string'], boolean:['bool'], integer:['uint32','uint64'], number:['double']}[jsonType];
      assert(permitted?.includes(field.type), type.fullName + '.' + name + ' type/schema drift');
      if (!field.repeated) assert(field.partOf, type.fullName + '.' + name + ' lacks explicit presence');
    }
  }
}

const actual = [];
function visit(namespace) {
  for (const child of Object.values(namespace.nested || {})) {
    if (child instanceof protobuf.Service) {
      for (const method of child.methodsArray) actual.push(child.fullName.slice(1) + '/' + method.name);
    }
    visit(child);
  }
}
visit(root);
assert.deepEqual(actual.sort(), manifest.operations.map(op => op.service + '/' + op.rpc).sort());
assert.equal(actual.length, 20);
for (const op of manifest.operations) {
  const service = root.lookupService(op.service);
  const method = service.methods[op.rpc];
  assert.equal(method.resolvedRequestType.fullName.slice(1), op.requestType);
  assert.equal(method.resolvedResponseType.fullName.slice(1), op.responseType);
  assert(!method.requestStream && !method.responseStream, 'Only unary collaborations are selected');
  assert(loaded[op.service][op.rpc], 'grpc-js descriptor is missing');
  const fixture = fixtures.operations.find(value => value.operationId === op.operationId);
  for (const direction of ['request','response']) {
    const type = root.lookupType(op[direction+'Type']);
    const [view, source] = schemaFor(op[direction+'Schema']);
    assertWireShape(type, view, source);
    const message = type.fromObject(fixture[direction]);
    assert.equal(type.verify(message), null);
    const bytes = type.encode(message).finish();
    const raw = type.toObject(type.decode(bytes), {defaults:false, enums:String, longs:String});
    const [schema, file] = schemaFor(op[direction+'Schema']);
    const roundtrip = normalize(raw, schema, file);
    assert.deepEqual(roundtrip, fixture[direction], op.operationId + ' ' + direction + ' lost a field/value');
    const descriptor = loaded[op.service][op.rpc];
    const encoded = descriptor[direction+'Serialize'](fixture[direction]);
    const decoded = descriptor[direction+'Deserialize'](encoded);
    assert.deepEqual(normalize(decoded, schema, file), fixture[direction], 'grpc-js codec: ' + op.operationId);
  }
}

const eligibility = root.lookupType('tutor_matcher.tutor.v1.TutorEligibility');
const explicitFalse = eligibility.decode(eligibility.encode(eligibility.fromObject({approved:false})).finish());
assert(Object.hasOwn(explicitFalse, 'approved'));
assert.equal(explicitFalse.approved, false);
assert(!Object.hasOwn(eligibility.decode(new Uint8Array()), 'approved'));
const status = root.lookupType('tutor_matcher.wallet.v1.PaymentResult');
assert.equal(status.lookupEnum('Status').values.STATUS_UNSPECIFIED, 0);
const detail = root.lookupType('tutor_matcher.common.v1.ErrorDetail');
const error = {code:'REVISION_MISMATCH',message:'Synthetic conflict',requestId:'00000001-1111-4111-8111-111111111111',retryable:false,fields:[]};
const trailers = new grpc.Metadata();
trailers.set('tutor-error-bin', Buffer.from(detail.encode(detail.fromObject(error)).finish()));
const decoded = detail.toObject(detail.decode(trailers.get('tutor-error-bin')[0]), {defaults:false});
assert.equal(decoded.code, error.code);
assert.equal(decoded.retryable, false);
// Bound the largest declared availability shape without sending network traffic.
const slotType = root.lookupType('tutor_matcher.booking.v1.GetAvailabilityResponse');
const id = n => n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
const subjectIds = Array.from({length:100}, (_, n) => id(10000+n));
const start = Date.parse('2026-11-06T00:00:00.000Z');
const largest = {checkedAt:'2026-11-06T00:00:00.000Z', slots:Array.from({length:4464}, (_, n) => ({
  id:id(n+1), tutorId:id(9000), subjectIds, revision:'99999999999999999999',
  startsAt:new Date(start+n*1800000).toISOString(), endsAt:new Date(start+(n+1)*1800000).toISOString(),
}))};
const largestBytes = slotType.encode(slotType.fromObject(largest)).finish();
assert(largestBytes.length < manifest.transportDefaults.maxReceiveMessageBytes);
assert.equal(slotType.decode(largestBytes).slots.length, 4464);
console.log('PASS: bounded maximum availability codec payload fits the declared 32 MiB send/receive ceiling.');
console.log('PASS: 7 proto files, 20 unary methods, exact manifest/descriptors and schema field/type parity, 40 protobufjs and 40 grpc-js request/response round-trips, explicit false/missing presence, enum zero and typed error trailers.');
console.log('Business bounds and permission/recovery behavior still require runtime validation.');
