require('dotenv').config();
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const mongoose = require('mongoose');
const handlers = require('./availability.handlers');

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/booking_db';
  await mongoose.connect(mongoUri);
  console.log(`[Booking] MongoDB connected: ${mongoose.connection.name}`);

  const protoPath = path.resolve(__dirname, '../../proto/booking.proto');
  const definition = protoLoader.loadSync(protoPath, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
  const booking = grpc.loadPackageDefinition(definition).booking;
  const server = new grpc.Server();
  server.addService(booking.BookingService.service, handlers);
  const port = Number(process.env.GRPC_PORT || 50052);
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error) => {
    if (error) {
      console.error('[Booking] gRPC bind failed', error);
      process.exit(1);
    }
    console.log(`[Booking] gRPC listening on 0.0.0.0:${port}`);
  });
}

main().catch((error) => {
  console.error('[Booking] startup failed', error);
  process.exit(1);
});

