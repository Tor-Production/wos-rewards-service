-- Disabled community JSON source: durable poll gate, conditional validator and immutable first observation.
CREATE TABLE community_json_source_state (
  source_id TEXT PRIMARY KEY CHECK (source_id='community-json-wosc-staging'),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0,1)),
  etag TEXT,
  next_fetch_at TEXT NOT NULL,
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
  PRIMARY KEY(source_id,code)
);
CREATE INDEX idx_community_json_observations_active ON community_json_code_observations(source_id,source_active,code);
