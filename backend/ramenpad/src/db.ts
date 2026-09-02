import pg from "pg";

const { Pool } = pg;
export type Database = pg.Pool;

export function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function migrate(db: Database) {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS ramenpad;

    CREATE TABLE IF NOT EXISTS ramenpad.launches (
      token_address text PRIMARY KEY,
      pool_address text UNIQUE NOT NULL,
      launcher text NOT NULL,
      position_token_id numeric(78,0) NOT NULL,
      name text NOT NULL,
      symbol text NOT NULL,
      image_url text NOT NULL DEFAULT '',
      token0 text NOT NULL,
      token1 text NOT NULL,
      sqrt_price_x96 numeric(78,0) NOT NULL,
      tick_lower integer NOT NULL,
      tick_upper integer NOT NULL,
      launch_tx text UNIQUE NOT NULL,
      launch_block bigint NOT NULL,
      launched_at timestamptz NOT NULL,
      price_usd numeric NOT NULL DEFAULT (2000.0 / 6942000.0),
      market_cap_usd numeric NOT NULL DEFAULT 2000,
      volume_usd numeric NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE ramenpad.launches ADD COLUMN IF NOT EXISTS image_updated_at timestamptz;
    ALTER TABLE ramenpad.launches ALTER COLUMN price_usd SET DEFAULT (2000.0 / 6942000.0);
    ALTER TABLE ramenpad.launches ALTER COLUMN market_cap_usd SET DEFAULT 2000;

    CREATE TABLE IF NOT EXISTS ramenpad.trades (
      id text PRIMARY KEY,
      token_address text NOT NULL REFERENCES ramenpad.launches(token_address),
      pool_address text NOT NULL,
      side text NOT NULL CHECK (side IN ('buy','sell')),
      trader text NOT NULL,
      token_amount numeric(78,18) NOT NULL,
      ramen_amount numeric(78,18) NOT NULL,
      usd_value numeric NOT NULL,
      price_usd numeric NOT NULL,
      market_cap_usd numeric NOT NULL,
      sqrt_price_x96 numeric(78,0) NOT NULL,
      tx_hash text NOT NULL,
      log_index integer NOT NULL,
      block_number bigint NOT NULL,
      block_time timestamptz NOT NULL,
      UNIQUE(tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS ramenpad_trades_token_time ON ramenpad.trades(token_address, block_time DESC);
    CREATE INDEX IF NOT EXISTS ramenpad_trades_time ON ramenpad.trades(block_time DESC);

    CREATE TABLE IF NOT EXISTS ramenpad.fee_harvests (
      id text PRIMARY KEY,
      token_address text NOT NULL REFERENCES ramenpad.launches(token_address),
      position_token_id numeric(78,0) NOT NULL,
      launcher_token_amount numeric(78,18) NOT NULL,
      launcher_ramen_amount numeric(78,18) NOT NULL,
      dev_token_amount numeric(78,18) NOT NULL,
      dev_ramen_amount numeric(78,18) NOT NULL,
      owner_token_amount numeric(78,18) NOT NULL,
      owner_ramen_amount numeric(78,18) NOT NULL,
      total_fee_usd numeric NOT NULL,
      launcher_fee_usd numeric NOT NULL,
      protocol_fee_usd numeric NOT NULL,
      tx_hash text NOT NULL,
      log_index integer NOT NULL,
      block_number bigint NOT NULL,
      block_time timestamptz NOT NULL,
      UNIQUE(tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS ramenpad.fee_claims (
      id text PRIMARY KEY,
      token_address text NOT NULL REFERENCES ramenpad.launches(token_address),
      position_token_id numeric(78,0) NOT NULL,
      token_amount numeric(78,18) NOT NULL,
      ramen_amount numeric(78,18) NOT NULL,
      claimed_usd numeric NOT NULL,
      tx_hash text NOT NULL,
      log_index integer NOT NULL,
      block_number bigint NOT NULL,
      block_time timestamptz NOT NULL,
      UNIQUE(tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS ramenpad.protocol_fee_deposits (
      id text PRIMARY KEY,
      token_address text NOT NULL REFERENCES ramenpad.launches(token_address),
      position_token_id numeric(78,0) NOT NULL,
      asset text NOT NULL,
      dev_token_amount numeric(78,18) NOT NULL,
      dev_ramen_amount numeric(78,18) NOT NULL,
      owner_token_amount numeric(78,18) NOT NULL,
      owner_ramen_amount numeric(78,18) NOT NULL,
      tx_hash text NOT NULL,
      log_index integer NOT NULL,
      block_number bigint NOT NULL,
      block_time timestamptz NOT NULL,
      UNIQUE(tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS ramenpad_fee_harvests_token_time ON ramenpad.fee_harvests(token_address, block_time DESC);
    CREATE INDEX IF NOT EXISTS ramenpad_fee_claims_token_time ON ramenpad.fee_claims(token_address, block_time DESC);
    CREATE INDEX IF NOT EXISTS ramenpad_protocol_deposits_token_time
      ON ramenpad.protocol_fee_deposits(token_address, block_time DESC);

    DROP VIEW IF EXISTS ramenpad.fee_kpis;
    CREATE VIEW ramenpad.fee_kpis AS
    WITH harvest AS (
      SELECT token_address,
        count(*)::integer AS harvest_count,
        COALESCE(sum(launcher_token_amount),0) AS launcher_token_earned,
        COALESCE(sum(launcher_ramen_amount),0) AS launcher_ramen_earned,
        COALESCE(sum(dev_token_amount + owner_token_amount),0) AS protocol_token_earned,
        COALESCE(sum(dev_ramen_amount + owner_ramen_amount),0) AS protocol_ramen_earned,
        COALESCE(sum(total_fee_usd),0) AS total_fee_usd,
        COALESCE(sum(launcher_fee_usd),0) AS launcher_fee_usd,
        COALESCE(sum(protocol_fee_usd),0) AS protocol_fee_usd
      FROM ramenpad.fee_harvests GROUP BY token_address
    ), claims AS (
      SELECT token_address,
        COALESCE(sum(token_amount),0) AS launcher_token_claimed,
        COALESCE(sum(ramen_amount),0) AS launcher_ramen_claimed,
        COALESCE(sum(claimed_usd),0) AS launcher_claimed_usd
      FROM ramenpad.fee_claims GROUP BY token_address
    ), deposits AS (
      SELECT token_address,
        COALESCE(sum(dev_token_amount + owner_token_amount),0) AS protocol_token_deposited,
        COALESCE(sum(dev_ramen_amount + owner_ramen_amount),0) AS protocol_ramen_deposited
      FROM ramenpad.protocol_fee_deposits GROUP BY token_address
    )
    SELECT l.token_address,
      COALESCE(h.harvest_count,0) AS harvest_count,
      COALESCE(h.launcher_token_earned,0) AS launcher_token_earned,
      COALESCE(h.launcher_ramen_earned,0) AS launcher_ramen_earned,
      COALESCE(c.launcher_token_claimed,0) AS launcher_token_claimed,
      COALESCE(c.launcher_ramen_claimed,0) AS launcher_ramen_claimed,
      COALESCE(h.launcher_token_earned,0) - COALESCE(c.launcher_token_claimed,0) AS launcher_token_pending,
      COALESCE(h.launcher_ramen_earned,0) - COALESCE(c.launcher_ramen_claimed,0) AS launcher_ramen_pending,
      COALESCE(h.protocol_token_earned,0) AS protocol_token_earned,
      COALESCE(h.protocol_ramen_earned,0) AS protocol_ramen_earned,
      COALESCE(d.protocol_token_deposited,0) AS protocol_token_deposited,
      COALESCE(d.protocol_ramen_deposited,0) AS protocol_ramen_deposited,
      COALESCE(h.total_fee_usd,0) AS total_fee_usd,
      COALESCE(h.launcher_fee_usd,0) AS launcher_fee_usd,
      COALESCE(h.protocol_fee_usd,0) AS protocol_fee_usd,
      COALESCE(c.launcher_claimed_usd,0) AS launcher_claimed_usd
    FROM ramenpad.launches l
    LEFT JOIN harvest h USING(token_address)
    LEFT JOIN claims c USING(token_address)
    LEFT JOIN deposits d USING(token_address);

    CREATE TABLE IF NOT EXISTS ramenpad.indexer_state (
      worker text PRIMARY KEY,
      block_number bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}
