-- Phase 5 staging-spike acceptance safety boundary.
-- Existing events and outputs remain normal and dispatchable according to their prior state.
ALTER TABLE processed_events ADD COLUMN acceptance_class TEXT NOT NULL DEFAULT 'normal'
  CONSTRAINT ck_processed_events_acceptance_class
    CHECK (acceptance_class IN ('normal', 'staging_spike'));

ALTER TABLE discord_output_deliveries ADD COLUMN dispatch_eligible INTEGER NOT NULL DEFAULT 1
  CONSTRAINT ck_dod_dispatch_eligible_bool CHECK (dispatch_eligible IN (0, 1));
ALTER TABLE discord_output_deliveries ADD COLUMN suppression_reason TEXT
  CONSTRAINT ck_dod_suppression_reason
    CHECK (suppression_reason IS NULL OR suppression_reason = 'staging_spike_sender');
ALTER TABLE discord_output_deliveries ADD COLUMN suppressed_at TEXT;
ALTER TABLE discord_output_deliveries ADD COLUMN permanent_dispatch_block INTEGER NOT NULL DEFAULT 0
  CONSTRAINT ck_dod_permanent_dispatch_block_bool
    CHECK (permanent_dispatch_block IN (0, 1));

-- acceptance_class is write-once for every event, not just spike evidence.
CREATE TRIGGER trg_processed_events_acceptance_class_immutable
BEFORE UPDATE OF acceptance_class ON processed_events
WHEN NEW.acceptance_class IS NOT OLD.acceptance_class
BEGIN
  SELECT RAISE(ABORT, 'processed_event_acceptance_class_immutable');
END;

-- A staging-spike marker can only enter the database in its complete terminal shape.
CREATE TRIGGER trg_processed_events_staging_spike_insert_shape
BEFORE INSERT ON processed_events
WHEN NEW.acceptance_class = 'staging_spike' AND (
  NEW.status IS NOT 'finalized'
  OR NEW.outcome IS NOT 'invalid'
  OR NEW.operation_id IS NOT NULL
  OR NEW.validation_reason IS NULL
  OR NEW.received_at IS NULL
  OR NEW.accepted_at IS NULL
  OR NEW.committed_at IS NOT NULL
  OR NEW.finalized_at IS NOT NEW.accepted_at
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_event_terminal_shape_required');
END;

-- OLD state is authoritative: one UPDATE cannot reset every protected field at once.
CREATE TRIGGER trg_processed_events_staging_spike_update_block
BEFORE UPDATE ON processed_events
WHEN OLD.acceptance_class = 'staging_spike'
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_event_immutable');
END;

CREATE TRIGGER trg_processed_events_staging_spike_delete_block
BEFORE DELETE ON processed_events
WHEN OLD.acceptance_class = 'staging_spike'
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_event_delete_blocked');
END;

-- An output associated with a spike marker must be born permanently suppressed. The evidence
-- timestamp, group, and linkage are tied to the marker accepted in the preceding batch statement.
CREATE TRIGGER trg_discord_output_staging_spike_insert_shape
BEFORE INSERT ON discord_output_deliveries
WHEN EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = NEW.event_id AND e.acceptance_class = 'staging_spike'
) AND (
  NEW.delivery_group IS NOT (
    SELECT e.output_delivery_group FROM processed_events e WHERE e.event_id = NEW.event_id
  )
  OR NEW.operation_id IS NOT NULL
  OR NEW.output_type IS NOT 'validation_reply'
  OR NEW.chunk_index IS NOT 1
  OR NEW.chunk_total IS NOT 1
  OR NEW.has_footer IS NOT 0
  OR NEW.status IS NOT 'superseded'
  OR NEW.dispatch_eligible IS NOT 0
  OR NEW.suppression_reason IS NOT 'staging_spike_sender'
  OR NEW.suppressed_at IS NOT (
    SELECT e.accepted_at FROM processed_events e WHERE e.event_id = NEW.event_id
  )
  OR NEW.permanent_dispatch_block IS NOT 1
  OR NEW.blocked_at IS NOT (
    SELECT e.accepted_at FROM processed_events e WHERE e.event_id = NEW.event_id
  )
  OR NEW.claim_token IS NOT NULL
  OR NEW.claim_expires_at IS NOT NULL
  OR NEW.attempts IS NOT 0
  OR NEW.discord_message_id IS NOT NULL
  OR NEW.sent_at IS NOT NULL
  OR NEW.available_at IS NOT NULL
  OR NEW.last_error IS NOT NULL
  OR NEW.alerted_at IS NOT NULL
  OR NEW.created_at IS NOT (
    SELECT e.accepted_at FROM processed_events e WHERE e.event_id = NEW.event_id
  )
  OR NEW.updated_at IS NOT (
    SELECT e.accepted_at FROM processed_events e WHERE e.event_id = NEW.event_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_terminal_shape_required');
END;

-- Spike-only metadata cannot be attached to an unrelated or orphan output.
CREATE TRIGGER trg_discord_output_staging_spike_metadata_insert_guard
BEFORE INSERT ON discord_output_deliveries
WHEN (
  NEW.suppression_reason = 'staging_spike_sender'
  OR NEW.suppressed_at IS NOT NULL
  OR NEW.permanent_dispatch_block = 1
) AND NOT EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = NEW.event_id AND e.acceptance_class = 'staging_spike'
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_requires_spike_event');
END;

-- A normal output cannot be relinked to a spike marker, even in an exact suppressed shape.
CREATE TRIGGER trg_discord_output_staging_spike_association_update_block
BEFORE UPDATE OF event_id ON discord_output_deliveries
WHEN EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = NEW.event_id AND e.acceptance_class = 'staging_spike'
) AND NOT EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = OLD.event_id AND e.acceptance_class = 'staging_spike'
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_relink_blocked');
END;

CREATE TRIGGER trg_discord_output_staging_spike_metadata_update_guard
BEFORE UPDATE ON discord_output_deliveries
WHEN (
  NEW.suppression_reason = 'staging_spike_sender'
  OR NEW.suppressed_at IS NOT NULL
  OR NEW.permanent_dispatch_block = 1
) AND NOT EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = NEW.event_id AND e.acceptance_class = 'staging_spike'
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_requires_spike_event');
END;

-- Blanket immutability is deliberately based on OLD association, so a simultaneous reset of
-- event_id, status, suppression fields, block fields, and delivery state is still rejected.
CREATE TRIGGER trg_discord_output_staging_spike_update_block
BEFORE UPDATE ON discord_output_deliveries
WHEN EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = OLD.event_id AND e.acceptance_class = 'staging_spike'
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_immutable');
END;

CREATE TRIGGER trg_discord_output_staging_spike_delete_block
BEFORE DELETE ON discord_output_deliveries
WHEN EXISTS (
  SELECT 1 FROM processed_events e
  WHERE e.event_id = OLD.event_id AND e.acceptance_class = 'staging_spike'
)
BEGIN
  SELECT RAISE(ABORT, 'staging_spike_output_delete_blocked');
END;

-- Exactly one retained output-evidence row may exist for each accepted spike event.
CREATE UNIQUE INDEX uq_staging_spike_output_event
  ON discord_output_deliveries (event_id)
  WHERE suppression_reason = 'staging_spike_sender' AND permanent_dispatch_block = 1;
