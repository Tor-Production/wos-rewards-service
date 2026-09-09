-- Phase 4. Additive only: the twelve-table baseline remains unchanged.
ALTER TABLE operations ADD COLUMN summary_context TEXT;
ALTER TABLE operations ADD COLUMN repair_authorized_at TEXT;
ALTER TABLE operations ADD COLUMN frozen_at TEXT;
ALTER TABLE operation_players_snapshot ADD COLUMN display_name TEXT;
ALTER TABLE summary_item_snapshot ADD COLUMN code_label TEXT;
ALTER TABLE redemptions ADD COLUMN budget_generation INTEGER NOT NULL DEFAULT 1 CHECK (budget_generation >= 1);
ALTER TABLE redemptions ADD COLUMN provider_invocations INTEGER NOT NULL DEFAULT 0 CHECK (provider_invocations >= 0);
ALTER TABLE redemptions ADD COLUMN provider_invocation_limit INTEGER NOT NULL DEFAULT 4 CHECK (provider_invocation_limit BETWEEN 1 AND 101);
ALTER TABLE redemptions ADD COLUMN current_terminal_generation INTEGER;
ALTER TABLE redemptions ADD COLUMN last_observation_at TEXT;
ALTER TABLE redemptions ADD COLUMN last_attempt_id TEXT;
ALTER TABLE redemptions ADD COLUMN last_attempt_budget_generation INTEGER;
ALTER TABLE discord_output_deliveries ADD COLUMN available_at TEXT;
ALTER TABLE discord_output_deliveries ADD COLUMN last_error TEXT;
ALTER TABLE discord_output_deliveries ADD COLUMN blocked_at TEXT;
ALTER TABLE discord_output_deliveries ADD COLUMN alerted_at TEXT;

CREATE TABLE terminal_observations (
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  budget_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','already_redeemed','permanent_failure','retry_exhausted')),
  reason_code TEXT,
  attempt_state TEXT,
  cause TEXT,
  observed_at TEXT NOT NULL,
  mirror_cursor TEXT,
  mirror_complete INTEGER NOT NULL DEFAULT 0 CHECK (mirror_complete IN (0,1)),
  PRIMARY KEY (player_id, code, budget_generation),
  FOREIGN KEY (player_id,code) REFERENCES redemptions(player_id,code)
);
CREATE TABLE terminal_receipts (
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  budget_generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('applied','audited','superseded')),
  PRIMARY KEY (player_id,code,budget_generation,operation_id,item_key),
  FOREIGN KEY (player_id,code,budget_generation) REFERENCES terminal_observations(player_id,code,budget_generation),
  FOREIGN KEY (operation_id,item_key) REFERENCES operation_items(operation_id,item_key)
);
CREATE TABLE scheduler_progress (
  lane TEXT NOT NULL PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  turn INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dispatch_control (
  scope TEXT NOT NULL PRIMARY KEY,
  claim_token TEXT,
  claim_expires_at TEXT,
  available_at TEXT,
  blocked_at TEXT
);

UPDATE redemptions SET provider_invocations=MIN(attempts,4);
UPDATE redemptions SET current_terminal_generation=budget_generation,
  last_observation_at=COALESCE(terminal_at,updated_at,'1970-01-01T00:00:00.000Z')
  WHERE status IN ('success','already_redeemed','permanent_failure','retry_exhausted');
INSERT INTO terminal_observations
  (player_id,code,budget_generation,status,reason_code,attempt_state,cause,observed_at)
  SELECT player_id,code,budget_generation,status,reason_code,attempt_state,'migration',last_observation_at
  FROM redemptions WHERE current_terminal_generation IS NOT NULL;
UPDATE discord_output_deliveries SET available_at=COALESCE(created_at,'1970-01-01T00:00:00.000Z');
CREATE INDEX idx_terminal_observations_work ON terminal_observations(mirror_complete,observed_at);
CREATE INDEX idx_terminal_receipts_item ON terminal_receipts(operation_id,item_key);
CREATE INDEX idx_output_due ON discord_output_deliveries(blocked_at,status,available_at);
