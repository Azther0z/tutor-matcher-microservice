require('dotenv').config();
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const mongoose = require('mongoose');
const express = require('express');
const handlers = require('./availability.handlers');
const { availabilityRouter, bookingRouter } = require('./booking.routes');

async function main() {
  const mongoUri = process.env.MONGO_URI?.trim();
  if (!mongoUri) throw new Error('MONGO_URI is required. Add your MongoDB Atlas URI to booking-service/.env');
  await mongoose.connect(mongoUri, { dbName: 'booking_db' });
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

  const app = express();
  app.use(express.json());
  app.use('/availability', availabilityRouter);
  app.use('/bookings', bookingRouter);
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[Booking] request error', error);
    return res.status(500).json({ error: 'Internal server error' });
  });
  const httpPort = Number(process.env.HTTP_PORT || 4004);
  app.listen(httpPort, () => console.log(`[Booking] REST listening on http://127.0.0.1:${httpPort}`));
}

main().catch((error) => {
  console.error('[Booking] startup failed', error);
  process.exit(1);
});

