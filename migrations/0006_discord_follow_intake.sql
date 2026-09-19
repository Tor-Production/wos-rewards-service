-- Offline staging/mock Follow intake. Canonical rows claim a source message once;
-- alias rows also claim their destination event so changed replays cannot create work.
CREATE TABLE discovered_code_events (
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 17 AND 20 AND substr(event_id,1,1) BETWEEN '1' AND '9' AND event_id NOT GLOB '*[^0-9]*'),
  guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 17 AND 20 AND substr(guild_id,1,1) BETWEEN '1' AND '9' AND guild_id NOT GLOB '*[^0-9]*'),
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 17 AND 20 AND substr(channel_id,1,1) BETWEEN '1' AND '9' AND channel_id NOT GLOB '*[^0-9]*'),
  webhook_id TEXT NOT NULL CHECK (length(webhook_id) BETWEEN 17 AND 20 AND substr(webhook_id,1,1) BETWEEN '1' AND '9' AND webhook_id NOT GLOB '*[^0-9]*'),
  source_guild_id TEXT NOT NULL CHECK (length(source_guild_id) BETWEEN 17 AND 20 AND substr(source_guild_id,1,1) BETWEEN '1' AND '9' AND source_guild_id NOT GLOB '*[^0-9]*'),
  source_channel_id TEXT NOT NULL CHECK (length(source_channel_id) BETWEEN 17 AND 20 AND substr(source_channel_id,1,1) BETWEEN '1' AND '9' AND source_channel_id NOT GLOB '*[^0-9]*'),
  source_message_id TEXT NOT NULL CHECK (length(source_message_id) BETWEEN 17 AND 20 AND substr(source_message_id,1,1) BETWEEN '1' AND '9' AND source_message_id NOT GLOB '*[^0-9]*'),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
  expiry_label TEXT NOT NULL CHECK (length(expiry_label) BETWEEN 1 AND 40),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','duplicate_code','duplicate_source')),
  canonical_event_id TEXT REFERENCES discovered_code_events(event_id),
  operation_id TEXT REFERENCES operations(operation_id),
  discord_created_at TEXT NOT NULL CHECK (length(discord_created_at) BETWEEN 20 AND 35),
  accepted_at TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  PRIMARY KEY(event_id),
  CHECK ((status='duplicate_source' AND canonical_event_id IS NOT NULL AND canonical_event_id<>event_id AND operation_id IS NULL)
    OR (status IN ('pending','duplicate_code') AND canonical_event_id IS NULL AND operation_id IS NULL)
    OR (status='accepted' AND canonical_event_id IS NULL AND operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX discovered_code_canonical_source
  ON discovered_code_events(source_guild_id,source_channel_id,source_message_id)
  WHERE canonical_event_id IS NULL;

-- Acceptance can finalize pending rows once; first provenance cannot be rewritten afterwards.
CREATE TRIGGER discovered_code_events_immutable BEFORE UPDATE ON discovered_code_events
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'discovery_provenance_immutable'); END;
