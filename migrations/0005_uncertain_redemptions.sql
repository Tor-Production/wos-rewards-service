-- Additive dispatch evidence. A hold is local authority, never an upstream receipt.
ALTER TABLE redemptions ADD COLUMN dispatch_hold_token TEXT;
ALTER TABLE redemptions ADD COLUMN dispatch_hold_generation INTEGER CHECK (dispatch_hold_generation >= 1);
ALTER TABLE redemptions ADD COLUMN dispatch_hold_at TEXT;
ALTER TABLE operations ADD COLUMN uncertain_count INTEGER CHECK (uncertain_count >= 0);

-- Legacy unresolved grants have no proven replay contract. Old retry_wait could also
-- mean a lost response; charged pending work could be an expired grant reset by recovery.
-- Preserve their status, identity, counters and receipts; retain ambiguity without retrospectively asserting an outcome.
UPDATE redemptions SET dispatch_hold_token=COALESCE(current_invocation_token,'legacy-unattributed'),
  dispatch_hold_generation=budget_generation,dispatch_hold_at=updated_at
  WHERE status IN ('in_progress','retry_wait') OR (status='pending' AND provider_invocations>0);
