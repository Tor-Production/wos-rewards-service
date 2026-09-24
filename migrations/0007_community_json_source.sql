-- Disabled community JSON source: durable poll gate, conditional validator and immutable first observation.
CREATE TABLE community_json_source_state (
  source_id TEXT PRIMARY KEY CHECK (source_id='community-json-wosc-staging'),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0,1)),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)),
  etag TEXT,
  last_source_updated_at TEXT,
  next_fetch_at TEXT NOT NULL,
  pending_snapshot_json TEXT,
  pending_etag TEXT,
  pending_source_updated_at TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE community_json_code_observations (
  source_id TEXT NOT NULL REFERENCES community_json_source_state(source_id),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
  first_source_updated_at TEXT NOT NULL,
  first_source_seen_at TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  baseline INTEGER NOT NULL CHECK (baseline IN (0,1)),
  source_active INTEGER NOT NULL CHECK (source_active IN (0,1)),
  withdrawn_at TEXT,
  operation_id TEXT REFERENCES operations(operation_id),
  acceptance_id TEXT,
  PRIMARY KEY(source_id,code)
);
CREATE INDEX idx_community_json_observations_active ON community_json_code_observations(source_id,source_active,code);
CREATE TRIGGER community_json_first_observation_immutable
BEFORE UPDATE ON community_json_code_observations
WHEN NEW.source_id<>OLD.source_id OR NEW.code<>OLD.code
  OR NEW.first_source_updated_at<>OLD.first_source_updated_at
  OR NEW.first_source_seen_at<>OLD.first_source_seen_at
  OR NEW.first_observed_at<>OLD.first_observed_at
  OR NEW.baseline<>OLD.baseline OR NEW.acceptance_id IS NOT OLD.acceptance_id
  OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'community_provenance_immutable'); END;

-- An independently accepted Follow/manual sighting can reactivate a community-first code.
-- The first-source columns and the community observation stay immutable.
CREATE TRIGGER community_json_follow_reactivation AFTER UPDATE OF status ON discovered_code_events
WHEN NEW.status IN ('accepted','duplicate_code')
BEGIN
  UPDATE gift_codes SET status='active' WHERE code=NEW.code
    AND source='community-json-wosc-staging' AND status='disabled'
    AND EXISTS(SELECT 1 FROM community_json_code_observations
      WHERE source_id='community-json-wosc-staging' AND code=NEW.code AND source_active=0);
END;
CREATE TRIGGER community_json_manual_reactivation AFTER UPDATE OF status ON manual_code_commands
WHEN NEW.status IN ('accepted','duplicate_code')
BEGIN
  UPDATE gift_codes SET status='active' WHERE code=NEW.code
    AND source='community-json-wosc-staging' AND status='disabled'
    AND EXISTS(SELECT 1 FROM community_json_code_observations
      WHERE source_id='community-json-wosc-staging' AND code=NEW.code AND source_active=0);
END;
