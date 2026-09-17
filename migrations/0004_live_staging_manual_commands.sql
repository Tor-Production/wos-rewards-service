-- Task 09 staging-only manual gift-code command ledger.
-- The Discord message id is the durable idempotency key. The transient pending state is only
-- visible inside the atomic D1 batch that also creates (or deduplicates) the distribution.
CREATE TABLE manual_code_commands (
  event_id TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_event_id
      CHECK (length(event_id) BETWEEN 1 AND 20 AND event_id NOT GLOB '*[^0-9]*'),
  guild_id TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_guild_id
      CHECK (length(guild_id) BETWEEN 1 AND 20 AND guild_id NOT GLOB '*[^0-9]*'),
  channel_id TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_channel_id
      CHECK (length(channel_id) BETWEEN 1 AND 20 AND channel_id NOT GLOB '*[^0-9]*'),
  author_id TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_author_id
      CHECK (length(author_id) BETWEEN 1 AND 20 AND author_id NOT GLOB '*[^0-9]*'),
  code TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_code
      CHECK (
        length(code) BETWEEN 1 AND 64
        AND code NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
  status TEXT NOT NULL
    CONSTRAINT ck_manual_code_commands_status
      CHECK (status IN ('pending', 'accepted', 'duplicate_code')),
  operation_id TEXT,
  discord_created_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  PRIMARY KEY (event_id),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
  CONSTRAINT ck_manual_code_commands_result CHECK (
    (status = 'pending' AND operation_id IS NULL)
    OR (status = 'accepted' AND operation_id IS NOT NULL)
    OR (status = 'duplicate_code' AND operation_id IS NULL)
  )
);
