require('dotenv').config();
const amqp = require('amqplib');
const mongoose = require('mongoose');
const Delivery = require('./delivery.model');
const { render } = require('./messages');

const EXCHANGE = 'tutor-matcher.events';
const QUEUE = 'notification.events';

async function connectBroker(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await amqp.connect(url);
    } catch (error) {
      if (attempt >= 30) throw error;
      console.warn(`[Notification] RabbitMQ not ready (${error.message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function handle(channel, msg) {
  let event;
  try {
    event = JSON.parse(msg.content.toString());
  } catch {
    console.error('[Notification] dropping message that is not JSON');
    return channel.nack(msg, false, false);
  }
  const rendered = render(event);
  if (!rendered) {
    console.log(`[Notification] ignored ${event.type}`);
    return channel.ack(msg);
  }
  try {
    await Delivery.create({ eventId: event.eventId, type: event.type, ...rendered });
    console.log(`[Notification] SEND to ${rendered.recipients.join(', ')}: ${rendered.message}`);
    channel.ack(msg);
  } catch (error) {
    if (error.code === 11000) {
      console.log(`[Notification] duplicate ${event.eventId} already delivered; skipped`);
      return channel.ack(msg);
    }
    console.error('[Notification] could not record delivery', error);
    channel.nack(msg, false, true);
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI?.trim();
  if (!mongoUri) throw new Error('MONGO_URI is required. Add it to notification-service/.env');
  await mongoose.connect(mongoUri, { dbName: 'notification_db' });
  console.log(`[Notification] MongoDB connected: ${mongoose.connection.name}`);

  const connection = await connectBroker(process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672');
  connection.on('close', () => {
    console.error('[Notification] RabbitMQ connection closed');
    process.exit(1);
  });
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, '#');
  await channel.prefetch(1);
  await channel.consume(QUEUE, (msg) => msg && handle(channel, msg), { noAck: false });
  console.log(`[Notification] consuming ${QUEUE} bound to ${EXCHANGE}`);
}

main().catch((error) => {
  console.error('[Notification] startup failed', error);
  process.exit(1);
});
