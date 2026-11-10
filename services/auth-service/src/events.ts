import amqp, { type ConfirmChannel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { pool } from './db';

const exchange = 'tutor-matcher.events';
let channel: ConfirmChannel | undefined;
let connection: ChannelModel | undefined;
let connectionTask: Promise<ConfirmChannel> | undefined;
let publisherUsername = '';

async function getConfirmChannel(): Promise<ConfirmChannel> {
  if (channel) return channel;
  if (connectionTask) return connectionTask;
  connectionTask = (async () => {
    const url = process.env.RABBITMQ_URL;
    if (!url) throw new Error('RABBITMQ_URL is not configured');
    const parsed = new URL(url);
    publisherUsername = decodeURIComponent(parsed.username || 'guest');
    const opened = await amqp.connect(url);
    connection = opened;
    opened.on('close', () => { channel = undefined; connection = undefined; connectionTask = undefined; });
    opened.on('error', () => { channel = undefined; connection = undefined; connectionTask = undefined; });
    const active = await opened.createConfirmChannel();
    await active.assertExchange(exchange, 'topic', { durable: true });
    await active.assertExchange('tutor-matcher.dead','direct',{durable:true});
    await active.assertQueue('notification.events.v1.dead',{durable:true});
    await active.bindQueue('notification.events.v1.dead','tutor-matcher.dead','notification.invalid');
    await active.assertQueue('notification.events.v1',{durable:true,arguments:{'x-dead-letter-exchange':'tutor-matcher.dead','x-dead-letter-routing-key':'notification.invalid'}});
    await active.bindQueue('notification.events.v1',exchange,'v1.#');
    active.on('return', (message: ConsumeMessage) => {
      const id = message.properties.messageId ?? 'unknown';
      returnedMessages.add(id);
    });
    channel = active;
    return active;
  })();
  try { return await connectionTask; }
  catch (error) { connectionTask = undefined; throw error; }
}

const returnedMessages = new Set<string>();

async function publish(payload: Record<string, any>, routingKey: string): Promise<void> {
  const active = await getConfirmChannel();
  const id = String(payload.eventId);
  returnedMessages.delete(id);
  await new Promise<void>((resolve, reject) => {
    active.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: id,
      type: String(payload.type),
      userId: publisherUsername,
    }, error => error ? reject(error) : resolve());
  });
  await active.waitForConfirms();
  if (returnedMessages.delete(id)) throw new Error('Event had no matching queue binding');
}

async function runOnce(): Promise<boolean> {
  const client = await pool.connect();
  let event: { event_id: string; routing_key: string; payload: Record<string, any>; attempts: number } | undefined;
  const lockId = randomUUID();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT event_id,routing_key,payload FROM events_outbox
      WHERE published_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now())
      ORDER BY created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!result.rowCount) { await client.query('COMMIT'); return false; }
    const found=result.rows[0] as { event_id: string; routing_key: string; payload: Record<string, any>; attempts: number };
    event = found;
    const claimed=await client.query('UPDATE events_outbox SET lock_id=$2,locked_until=now()+interval \'30 seconds\',attempts=attempts+1 WHERE event_id=$1 RETURNING attempts', [found.event_id,lockId]);
    found.attempts=claimed.rows[0].attempts;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
  if (!event) return false;
  const claimed=event;
  try {
    await publish(claimed.payload,claimed.routing_key);
    await pool.query(`UPDATE events_outbox SET published_at=now(),locked_until=NULL,lock_id=NULL,last_error=NULL
      WHERE event_id=$1 AND lock_id=$2 AND attempts=$3`,[claimed.event_id,lockId,claimed.attempts]);
  } catch (error) {
    // Broker outages and unroutable messages leave durable work for a later attempt.
    const detail = error instanceof Error ? `PUBLISH_${error.name.slice(0,80)}` : 'PUBLISH_FAILED';
    await pool.query(`UPDATE events_outbox SET locked_until=NULL,lock_id=NULL,last_error=$3,
      available_at=now()+make_interval(secs=>LEAST(60,power(2,LEAST(attempts-1,6))::int)+floor(random()*power(2,LEAST(attempts-1,6)))::int),
      needs_attention_at=CASE WHEN attempts>=10 THEN COALESCE(needs_attention_at,now()) ELSE needs_attention_at END
      WHERE event_id=$1 AND lock_id=$2 AND attempts=$4`,[claimed.event_id,lockId,detail,claimed.attempts]);
    throw error;
  }
  return true;
}

export function startOutboxPublisher(): () => void {
  let stopped = false;
  let active = false;
  let lastExpiryCleanup=0;
  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      if(Date.now()-lastExpiryCleanup>60_000){
        await pool.query(`UPDATE reset_contents SET consumed_at=COALESCE(consumed_at,expires_at),ciphertext=decode('','hex'),auth_tag=decode('','hex')
          WHERE expires_at<=now() AND octet_length(ciphertext)>0`);
        lastExpiryCleanup=Date.now();
      }
      while (!stopped && await runOnce()) { /* Drain a small durable backlog. */ }
    } catch {
      // The publisher retries from the persistent outbox. Do not log payloads or broker strings.
    } finally { active = false; }
  };
  const timer = setInterval(() => { void tick(); }, 1000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); void connection?.close().catch(() => undefined); };
}
