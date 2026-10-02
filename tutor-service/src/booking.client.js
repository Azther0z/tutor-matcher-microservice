const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const protoPath = path.resolve(__dirname, '../../proto/booking.proto');
const definition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const { BookingService } = grpc.loadPackageDefinition(definition).booking;
const client = new BookingService(
  process.env.BOOKING_GRPC_URL || '127.0.0.1:50052',
  grpc.credentials.createInsecure(),
);

function getAvailability(tutorId) {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 2000);
    client.GetAvailability({ tutorId }, { deadline }, (error, response) => {
      if (error) return reject(error);
      resolve(response.slots || []);
    });
  });
}

module.exports = { getAvailability };

