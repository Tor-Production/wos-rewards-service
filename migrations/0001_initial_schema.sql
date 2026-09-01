-- Migration number: 0001 	 2026-09-02T00:00:00.000Z
--
-- Baseline schema for the wos-rewards-service D1 database.
--
-- Implements docs/architecture/data-model-and-outbox.md section 12 in full: all twelve
-- application tables, their integrity constraints, and only the indexes justified by a
-- documented access pattern.
--
-- Conventions (see section 12, "Implemented schema (migration 0001)"):
--   * every identifier is TEXT; PLAYER_ID and STATE are never INTEGER, so large ids keep
--     their precision and leading zeroes survive (section 10, [fact:C9]);
--   * every timestamp is TEXT holding ISO-8601 UTC, written by the application. There are
--     deliberately no SQL timestamp defaults: CURRENT_TIMESTAMP renders
--     "YYYY-MM-DD HH:MM:SS", which would neither sort nor compare against ISO-8601;
--   * boolean-like columns are INTEGER constrained to 0/1;
--   * counters are INTEGER NOT NULL DEFAULT 0 with a non-negative check;
--   * every CHECK is named, so SQLite reports "CHECK constraint failed: <name>" and a
--     failure identifies the exact rule that fired;
--   * no triggers, no views, no AUTOINCREMENT, no cascade behaviour. Every foreign key
--     uses SQLite's default ON DELETE NO ACTION ON UPDATE NO ACTION;
--   * there are no UNIQUE constraints or unique indexes other than the PRIMARY KEYs. The
--     documented seal and render passes use targeted upserts
--     (ON CONFLICT (operation_id, player_id, code) / (delivery_id) DO NOTHING), and in
--     SQLite a targeted DO NOTHING aborts on a conflict against any *other* unique index,
--     which would break the crash-resumed passes in section 15.4. Every uniqueness
--     property that might have been added is already functionally determined by a
--     primary key.
--
-- D1 enforces foreign keys by default, and db.batch() runs statements sequentially inside
-- one transaction, so within a batch parents must be written before children:
--   players / gift_codes -> operations -> operation_items -> outbox_jobs, and
--   processed_events -> discord_output_deliveries.
-- PRAGMA defer_foreign_keys = on is the in-transaction escape hatch if a future flow
-- genuinely needs another order.

-- ---------------------------------------------------------------------------------------
-- players -- section 12. Re-registration is an upsert on player_id.
-- ---------------------------------------------------------------------------------------
CREATE TABLE players (
  player_id TEXT NOT NULL
    CONSTRAINT ck_players_player_id_digits
      CHECK (player_id <> '' AND player_id NOT GLOB '*[^0-9]*'),
  state TEXT NOT NULL
    CONSTRAINT ck_players_state_digits
      CHECK (state <> '' AND state NOT GLOB '*[^0-9]*'),
  state_updated_at TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id)
);

-- ---------------------------------------------------------------------------------------
-- gift_codes -- section 12. code is the dedupe key.
-- ---------------------------------------------------------------------------------------
CREATE TABLE gift_codes (
  code TEXT NOT NULL
    CONSTRAINT ck_gift_codes_code_present CHECK (code <> ''),
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT ck_gift_codes_status CHECK (status IN ('active', 'expired', 'disabled')),
  discovered_at TEXT NOT NULL,
  source TEXT NOT NULL,
  -- Provenance only. Deliberately not a foreign key: a discovered code's first sighting is
  -- not necessarily an ingested registration event.
  first_seen_event_id TEXT,
  PRIMARY KEY (code)
);

-- ---------------------------------------------------------------------------------------
-- operations -- section 12.
-- ---------------------------------------------------------------------------------------
CREATE TABLE operations (
  operation_id TEXT NOT NULL
    CONSTRAINT ck_operations_operation_id_present CHECK (operation_id <> ''),
  type TEXT NOT NULL
    CONSTRAINT ck_operations_type
      CHECK (type IN ('registration_run', 'code_distribution_run', 'repair_run')),
  trigger_kind TEXT NOT NULL
    CONSTRAINT ck_operations_trigger_kind
      CHECK (trigger_kind IN ('discord_event', 'discovered_code', 'human_repair')),
  trigger_ref TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  expected_count INTEGER NOT NULL
    CONSTRAINT ck_operations_expected_count_nonneg CHECK (expected_count >= 0),
  expansion_state TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_operations_expansion_state
      CHECK (expansion_state IN ('pending', 'expanding', 'expanded')),
  expansion_cursor TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_operations_state
      CHECK (state IN (
        'pending', 'in_progress', 'awaiting_summary', 'summarized', 'stale_closed'
      )),
  deadline_at TEXT NOT NULL,
  summary_state TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT ck_operations_summary_state
      CHECK (summary_state IN (
        'none', 'sealing', 'building', 'built', 'delivering', 'delivered'
      )),
  snapshot_cursor TEXT,
  snapshot_sealed_at TEXT,
  summary_delivery_group TEXT,
  -- A zero-result operation still produces exactly one chunk (section 15.5), so the floor
  -- is 1 once the layout pass sets it. SUMMARY_MAX_CHUNKS is configuration, not schema.
  summary_chunk_total INTEGER
    CONSTRAINT ck_operations_summary_chunk_total_positive
      CHECK (summary_chunk_total IS NULL OR summary_chunk_total >= 1),
  summary_layout_cursor TEXT,
  summary_layout_open TEXT,
  summary_build_cursor INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_operations_summary_build_cursor_nonneg CHECK (summary_build_cursor >= 0),
  success_count INTEGER
    CONSTRAINT ck_operations_success_count_nonneg
      CHECK (success_count IS NULL OR success_count >= 0),
  already_redeemed_count INTEGER
    CONSTRAINT ck_operations_already_redeemed_count_nonneg
      CHECK (already_redeemed_count IS NULL OR already_redeemed_count >= 0),
  permanent_failure_count INTEGER
    CONSTRAINT ck_operations_permanent_failure_count_nonneg
      CHECK (permanent_failure_count IS NULL OR permanent_failure_count >= 0),
  retry_exhausted_count INTEGER
    CONSTRAINT ck_operations_retry_exhausted_count_nonneg
      CHECK (retry_exhausted_count IS NULL OR retry_exhausted_count >= 0),
  completed_count INTEGER
    CONSTRAINT ck_operations_completed_count_nonneg
      CHECK (completed_count IS NULL OR completed_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id)
);

-- ---------------------------------------------------------------------------------------
-- processed_events -- section 12, the event-acceptance state machine.
-- The row is only ever inserted in the same db.batch() as the validation-reply delivery
-- row (invalid) or the registration work + outbox rows (valid).
-- ---------------------------------------------------------------------------------------
CREATE TABLE processed_events (
  event_id TEXT NOT NULL
    CONSTRAINT ck_processed_events_event_id_present CHECK (event_id <> ''),
  kind TEXT NOT NULL
    CONSTRAINT ck_processed_events_kind CHECK (kind IN ('registration')),
  -- No default: the initial status differs per branch and must be written explicitly.
  status TEXT NOT NULL
    CONSTRAINT ck_processed_events_status
      CHECK (status IN (
        'accepted_invalid', 'accepted_valid', 'work_committed', 'finalized'
      )),
  outcome TEXT
    CONSTRAINT ck_processed_events_outcome
      CHECK (outcome IS NULL OR outcome IN ('invalid', 'valid')),
  operation_id TEXT,
  validation_reason TEXT,
  -- Deterministic per event and always derivable, so NOT NULL for valid events too.
  output_delivery_group TEXT NOT NULL,
  received_at TEXT,
  accepted_at TEXT,
  committed_at TEXT,
  finalized_at TEXT,
  PRIMARY KEY (event_id),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

-- ---------------------------------------------------------------------------------------
-- redemptions -- section 12, the global provider-call authority.
-- The T1-T16 transitions in section 15.2 are deliberately NOT encoded here: only the flat
-- status domain is constrained, so no documented intermediate state can be blocked.
-- ---------------------------------------------------------------------------------------
CREATE TABLE redemptions (
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL
    CONSTRAINT ck_redemptions_idempotency_key_present CHECK (idempotency_key <> ''),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_redemptions_status
      CHECK (status IN (
        'pending', 'in_progress', 'retry_wait',
        'success', 'already_redeemed', 'permanent_failure', 'retry_exhausted'
      )),
  current_attempt_id TEXT,
  current_invocation_token TEXT,
  invocation_expires_at TEXT,
  retry_due_at TEXT,
  attempt_state TEXT,
  attempt_generation INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_redemptions_attempt_generation_nonneg CHECK (attempt_generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_redemptions_attempts_nonneg CHECK (attempts >= 0),
  reeval_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_redemptions_reeval_count_nonneg CHECK (reeval_count >= 0),
  provider_receipt TEXT,
  reason_code TEXT,
  first_claimed_at TEXT,
  terminal_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (player_id, code),
  FOREIGN KEY (player_id) REFERENCES players (player_id),
  FOREIGN KEY (code) REFERENCES gift_codes (code)
);

-- ---------------------------------------------------------------------------------------
-- operation_items -- section 12. The item lease is a coarse redelivery filter; it does not
-- authorize a provider call.
-- ---------------------------------------------------------------------------------------
CREATE TABLE operation_items (
  operation_id TEXT NOT NULL,
  item_key TEXT NOT NULL
    CONSTRAINT ck_operation_items_item_key_present CHECK (item_key <> ''),
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  job_id TEXT NOT NULL
    CONSTRAINT ck_operation_items_job_id_present CHECK (job_id <> ''),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_operation_items_status
      CHECK (status IN (
        'pending', 'in_progress',
        'success', 'already_redeemed', 'permanent_failure', 'retry_exhausted'
      )),
  display_label TEXT NOT NULL,
  claim_token TEXT,
  claim_expires_at TEXT,
  reason_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_operation_items_attempts_nonneg CHECK (attempts >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, item_key),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
  FOREIGN KEY (player_id) REFERENCES players (player_id),
  FOREIGN KEY (code) REFERENCES gift_codes (code)
);

-- ---------------------------------------------------------------------------------------
-- operation_players_snapshot -- section 12. Distribution runs only; included in the
-- baseline migration so the documented schema is complete.
-- ---------------------------------------------------------------------------------------
CREATE TABLE operation_players_snapshot (
  operation_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, player_id),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
  FOREIGN KEY (player_id) REFERENCES players (player_id)
);

-- ---------------------------------------------------------------------------------------
-- operation_late_results -- section 12. Outcomes observed after the summary freeze.
-- There is deliberately no foreign key to redemptions(player_id, code): the post-seal
-- outbox-dead path records retry_exhausted with reason_code 'outbox_dead'
-- (operations-and-reliability.md section 22) for work that never reached a consumer, so no
-- redemptions row need exist.
-- ---------------------------------------------------------------------------------------
CREATE TABLE operation_late_results (
  operation_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL
    CONSTRAINT ck_operation_late_results_status
      CHECK (status IN (
        'success', 'already_redeemed', 'permanent_failure', 'retry_exhausted'
      )),
  reason_code TEXT,
  PRIMARY KEY (operation_id, player_id, code, observed_at),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
  FOREIGN KEY (player_id) REFERENCES players (player_id),
  FOREIGN KEY (code) REFERENCES gift_codes (code)
);

-- ---------------------------------------------------------------------------------------
-- summary_item_snapshot -- section 12. Immutable rendered inputs, sealed once.
-- player_id / code carry no foreign key on purpose: section 15.4 states the seal never
-- reads players, and the snapshot must stay an immutable historical record.
-- ---------------------------------------------------------------------------------------
CREATE TABLE summary_item_snapshot (
  operation_id TEXT NOT NULL,
  player_id TEXT NOT NULL
    CONSTRAINT ck_summary_item_snapshot_player_id_present CHECK (player_id <> ''),
  code TEXT NOT NULL
    CONSTRAINT ck_summary_item_snapshot_code_present CHECK (code <> ''),
  status TEXT NOT NULL
    CONSTRAINT ck_summary_item_snapshot_status
      CHECK (status IN (
        'success', 'already_redeemed', 'permanent_failure', 'retry_exhausted',
        'still_pending'
      )),
  reason_code TEXT,
  display_label TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, player_id, code),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

-- ---------------------------------------------------------------------------------------
-- summary_chunk_layout -- section 12. Deterministic item-to-chunk assignment.
-- first_sort_key / last_sort_key are nullable on purpose: section 15.5 documents a
-- zero-result operation that seals zero snapshot rows and still yields
-- summary_chunk_total = 1, so that single chunk has no sort-key bounds. The paired check
-- keeps the "both or neither" invariant.
-- ---------------------------------------------------------------------------------------
CREATE TABLE summary_chunk_layout (
  operation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL
    CONSTRAINT ck_summary_chunk_layout_chunk_index_positive CHECK (chunk_index >= 1),
  first_sort_key TEXT,
  last_sort_key TEXT,
  overflow_remaining INTEGER
    CONSTRAINT ck_summary_chunk_layout_overflow_nonneg
      CHECK (overflow_remaining IS NULL OR overflow_remaining >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, chunk_index),
  CONSTRAINT ck_scl_sort_key_pair
    CHECK (
      (first_sort_key IS NULL AND last_sort_key IS NULL)
      OR (first_sort_key IS NOT NULL AND last_sort_key IS NOT NULL)
    ),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

-- ---------------------------------------------------------------------------------------
-- discord_output_deliveries -- section 12. Durable per-message output.
-- All chunks of a logical message are built and persisted before any are sent, so
-- chunk_total is already final when each row is inserted.
-- sent_at / created_at / updated_at are nullable because section 12 marks them TEXT NULL.
-- ---------------------------------------------------------------------------------------
CREATE TABLE discord_output_deliveries (
  delivery_id TEXT NOT NULL
    CONSTRAINT ck_dod_delivery_id_present CHECK (delivery_id <> ''),
  delivery_group TEXT NOT NULL
    CONSTRAINT ck_dod_delivery_group_present CHECK (delivery_group <> ''),
  event_id TEXT,
  operation_id TEXT,
  channel_id TEXT NOT NULL,
  output_type TEXT NOT NULL
    CONSTRAINT ck_dod_output_type
      CHECK (output_type IN (
        'validation_reply', 'registration_summary', 'distribution_summary',
        'partial_summary'
      )),
  chunk_index INTEGER NOT NULL
    CONSTRAINT ck_dod_chunk_index_positive CHECK (chunk_index >= 1),
  chunk_total INTEGER NOT NULL
    CONSTRAINT ck_dod_chunk_total_positive CHECK (chunk_total >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  has_footer INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_dod_has_footer_bool CHECK (has_footer IN (0, 1)),
  -- Deterministic, derived by hashing delivery_id: at most 25 characters [fact:D6], and
  -- never empty, since an empty nonce would silently disable enforce_nonce suppression.
  nonce TEXT NOT NULL
    CONSTRAINT ck_dod_nonce_length CHECK (length(nonce) BETWEEN 1 AND 25),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_dod_status
      CHECK (status IN ('pending', 'claimed', 'sent', 'superseded')),
  claim_token TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_dod_attempts_nonneg CHECK (attempts >= 0),
  discord_message_id TEXT,
  sent_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (delivery_id),
  CONSTRAINT ck_dod_chunk_within_total CHECK (chunk_index <= chunk_total),
  -- The runtime footer belongs only to the final chunk of a summary, never to a
  -- validation reply and never to an earlier chunk (section 15.4).
  CONSTRAINT ck_dod_footer_placement
    CHECK (
      has_footer = 0
      OR (chunk_index = chunk_total AND output_type <> 'validation_reply')
    ),
  FOREIGN KEY (event_id) REFERENCES processed_events (event_id),
  FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

-- ---------------------------------------------------------------------------------------
-- outbox_jobs -- section 12 and section 14. The composite foreign key is the strongest
-- integrity guarantee here: an outbox job can never exist without the domain row it was
-- committed with.
-- ---------------------------------------------------------------------------------------
CREATE TABLE outbox_jobs (
  job_id TEXT NOT NULL
    CONSTRAINT ck_outbox_jobs_job_id_present CHECK (job_id <> ''),
  operation_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  type TEXT NOT NULL
    CONSTRAINT ck_outbox_jobs_type CHECK (type IN ('registration', 'distribution')),
  attempt_id TEXT NOT NULL
    CONSTRAINT ck_outbox_jobs_attempt_id_present CHECK (attempt_id <> ''),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_outbox_jobs_status CHECK (status IN ('pending', 'enqueued', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_outbox_jobs_attempts_nonneg CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id),
  FOREIGN KEY (operation_id, item_key)
    REFERENCES operation_items (operation_id, item_key)
);

-- ---------------------------------------------------------------------------------------
-- Indexes. Only access patterns documented in the architecture are indexed; every primary
-- key already provides its own index, and no redundant prefix index is added.
-- ---------------------------------------------------------------------------------------

-- Section 6: snapshot the active codes for a registration run, in a fixed code order.
CREATE INDEX idx_gift_codes_status_code ON gift_codes (status, code);

-- Section 12 / section 9: sweeper re-drives events stuck at accepted_valid, oldest first.
CREATE INDEX idx_processed_events_status_accepted_at
  ON processed_events (status, accepted_at);

-- Section 15.2 crash-safe re-drive (T12): rows whose invocation lease expired. Also covers
-- retry_wait, whose invocation_expires_at is the documented "must be re-picked-up by" hint.
CREATE INDEX idx_redemptions_status_invocation_expires_at
  ON redemptions (status, invocation_expires_at);

-- Section 9 / section 15.4: operation sweeper force-closes operations past deadline_at.
CREATE INDEX idx_operations_state_deadline_at ON operations (state, deadline_at);

-- Section 9: summary builder and output dispatcher pick operations mid-pipeline, oldest
-- first.
CREATE INDEX idx_operations_summary_state_updated_at
  ON operations (summary_state, updated_at);

-- Section 16 idempotency lookup ("does an operation already exist for this trigger?") and
-- the section 14 repair lookup by origin operation_id.
CREATE INDEX idx_operations_trigger ON operations (trigger_kind, trigger_ref);

-- Section 15.4 paged seal pass: frozen items read in (player_id, code) order, resuming
-- after operations.snapshot_cursor. The primary key is (operation_id, item_key), which is
-- not this order.
CREATE INDEX idx_operation_items_operation_player_code
  ON operation_items (operation_id, player_id, code);

-- Section 15.1 item-lease sweep and section 15.3 completion accounting by status within
-- one operation.
CREATE INDEX idx_operation_items_operation_status_claim
  ON operation_items (operation_id, status, claim_expires_at);

-- Section 15.2 mirror write: from a terminal redemptions row, find the owning item row(s)
-- for that pair across operations. The primary key cannot serve a player_id-first lookup.
CREATE INDEX idx_operation_items_player_code ON operation_items (player_id, code);

-- Section 15.4: the layout and render passes read ORDER BY sort_key, resuming after
-- summary_layout_cursor, and render reads the first_sort_key..last_sort_key window.
CREATE INDEX idx_summary_item_snapshot_sort
  ON summary_item_snapshot (operation_id, sort_key);

-- Section 15.4 step 2: the dispatcher processes a group in chunk_index order and resumes
-- at the first non-sent row.
CREATE INDEX idx_discord_output_deliveries_group_chunk
  ON discord_output_deliveries (delivery_group, chunk_index);

-- Section 15.4 claim statement: pending, or claimed with an expired lease.
CREATE INDEX idx_discord_output_deliveries_status_claim
  ON discord_output_deliveries (status, claim_expires_at);

-- Section 14 authoritative Cron dispatcher: status='pending' AND available_at <= now.
CREATE INDEX idx_outbox_jobs_status_available_at ON outbox_jobs (status, available_at);

-- Section 14 atomic reopen and the sweeper's reset of stuck enqueued rows, both of which
-- address an outbox row by its operation and item.
CREATE INDEX idx_outbox_jobs_operation_item ON outbox_jobs (operation_id, item_key);
