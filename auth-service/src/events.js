const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');

const EXCHANGE = 'tutor-matcher.events';
let channelPromise = null;

function getChannel() {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672');
      connection.on('close', () => { channelPromise = null; });
      connection.on('error', () => { channelPromise = null; });
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      return channel;
    })();
    channelPromise.catch(() => { channelPromise = null; });
  }
  return channelPromise;
}

async function publish(type, data) {
  const event = { eventId: randomUUID(), type, occurredAt: new Date().toISOString(), data };
  try {
    const channel = await getChannel();
    channel.publish(EXCHANGE, type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
    });
    await channel.waitForConfirms();
    console.log(`[Auth] published ${type} ${event.eventId}`);
  } catch (error) {
    console.error(`[Auth] could not publish ${type}: ${error.message}`);
  }
}

module.exports = { publish };
