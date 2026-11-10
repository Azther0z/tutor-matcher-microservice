import type { Pool } from 'pg';
import type { Peers } from '../clients';
import type { Config } from '../config';
import type { Contracts } from '../contracts';
import type { IdempotencyStore } from '../http/idempotency';
import type { Clock } from '../time';

/** Everything the domain functions need. Tests build one with fakes; production wires the real peers. */
export interface Ctx {
  pool: Pool;
  clock: Clock;
  peers: Peers;
  contracts: Contracts;
  idem: IdempotencyStore;
  config: Pick<Config, 'demoMode'>;
}
