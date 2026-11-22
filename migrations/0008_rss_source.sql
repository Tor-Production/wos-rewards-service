-- Disabled RSS discovery: one durable poll gate plus immutable item/code provenance.
CREATE TABLE rss_source_state (
  source_id TEXT PRIMARY KEY CHECK (source_id='wosgiftcodes-rss-staging'),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0,1)),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)),
  next_fetch_at TEXT NOT NULL,
  pending_snapshot_json TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE rss_item_observations (
  source_id TEXT NOT NULL REFERENCES rss_source_state(source_id),
  item_id TEXT NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_published_at TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  baseline INTEGER NOT NULL CHECK (baseline IN (0,1)),
  PRIMARY KEY(source_id,item_id,code)
);
CREATE INDEX idx_rss_item_observations_code ON rss_item_observations(source_id,code,item_id);

CREATE TABLE rss_code_observations (
  source_id TEXT NOT NULL REFERENCES rss_source_state(source_id),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
  first_item_id TEXT NOT NULL,
  source_published_at TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  baseline INTEGER NOT NULL CHECK (baseline IN (0,1)),
  source_active INTEGER NOT NULL DEFAULT 1 CHECK (source_active IN (0,1)),
  operation_id TEXT REFERENCES operations(operation_id),
  acceptance_id TEXT,
  PRIMARY KEY(source_id,code),
  FOREIGN KEY(source_id,first_item_id,code)
    REFERENCES rss_item_observations(source_id,item_id,code)
);
CREATE INDEX idx_rss_code_observations_active
  ON rss_code_observations(source_id,source_active,code);

CREATE TRIGGER rss_item_first_observation_immutable
BEFORE UPDATE ON rss_item_observations
WHEN NEW.source_id<>OLD.source_id OR NEW.item_id<>OLD.item_id OR NEW.code<>OLD.code
  OR NEW.source_published_at<>OLD.source_published_at
  OR NEW.first_observed_at<>OLD.first_observed_at OR NEW.baseline<>OLD.baseline
BEGIN SELECT RAISE(ABORT,'rss_item_provenance_immutable'); END;

CREATE TRIGGER rss_code_first_observation_immutable
BEFORE UPDATE ON rss_code_observations
WHEN NEW.source_id<>OLD.source_id OR NEW.code<>OLD.code OR NEW.first_item_id<>OLD.first_item_id
  OR NEW.source_published_at<>OLD.source_published_at
  OR NEW.first_observed_at<>OLD.first_observed_at OR NEW.baseline<>OLD.baseline
  OR NEW.acceptance_id IS NOT OLD.acceptance_id
  OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'rss_provenance_immutable'); END;

-- A current RSS item is an independent active sighting if another source later withdraws it.
CREATE TRIGGER rss_community_code_reactivation AFTER INSERT ON rss_code_observations
WHEN NEW.source_active=1
BEGIN
  UPDATE gift_codes SET status='active' WHERE code=NEW.code
    AND source='community-json-wosc-staging' AND status='disabled';
END;
