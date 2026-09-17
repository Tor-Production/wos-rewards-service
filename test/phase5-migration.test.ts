import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const STAMP = "2026-09-12T03:00:00.000Z";
const PHASE5_MIGRATION = "0003_phase5_spike_output_suppression.sql";
const LIVE_STAGING_MIGRATION = "0004_live_staging_manual_commands.sql";

async function applyPhase4(db: D1Database): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2));
}

async function applyPhase5(db: D1Database): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 3));
}

async function seedNormalInvalid(
  db: D1Database,
  eventId: string,
  deliveryId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO processed_events
        (event_id,kind,status,outcome,validation_reason,output_delivery_group,received_at,accepted_at)
        VALUES (?1,'registration','accepted_invalid','invalid','player_id_not_numeric',?2,?3,?3)`,
      )
      .bind(eventId, `evt:${eventId}`, STAMP),
    db
      .prepare(
        `INSERT INTO discord_output_deliveries
        (delivery_id,delivery_group,event_id,channel_id,output_type,chunk_index,chunk_total,
         content,content_hash,has_footer,nonce,status,attempts,created_at,updated_at,available_at)
        VALUES (?1,?2,?3,'200','validation_reply',1,1,'validation','hash',0,?4,'pending',0,?5,?5,?5)`,
      )
      .bind(deliveryId, `evt:${eventId}`, eventId, `n-${eventId}`, STAMP),
  ]);
}

async function seedSpikeEvidence(
  db: D1Database,
  eventId = "9001",
  deliveryId = "spike-delivery-9001",
): Promise<{ eventId: string; deliveryId: string }> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO processed_events
        (event_id,kind,status,outcome,operation_id,validation_reason,output_delivery_group,
         received_at,accepted_at,committed_at,finalized_at,acceptance_class)
        VALUES (?1,'registration','finalized','invalid',NULL,'player_id_not_numeric',?2,
                ?3,?3,NULL,?3,'staging_spike')`,
      )
      .bind(eventId, `evt:${eventId}`, STAMP),
    db
      .prepare(
        `INSERT INTO discord_output_deliveries
        (delivery_id,delivery_group,event_id,operation_id,channel_id,output_type,chunk_index,
         chunk_total,content,content_hash,has_footer,nonce,status,claim_token,claim_expires_at,
         attempts,discord_message_id,sent_at,created_at,updated_at,available_at,last_error,
         blocked_at,alerted_at,dispatch_eligible,suppression_reason,suppressed_at,
         permanent_dispatch_block)
        VALUES (?1,?2,?3,NULL,'200','validation_reply',1,1,'validation evidence','hash',0,?4,
                'superseded',NULL,NULL,0,NULL,NULL,?5,?5,NULL,NULL,?5,NULL,0,
                'staging_spike_sender',?5,1)`,
      )
      .bind(deliveryId, `evt:${eventId}`, eventId, `n-${eventId}`, STAMP),
  ]);
  return { eventId, deliveryId };
}

async function triggerDefinitions(db: D1Database): Promise<Record<string, string>> {
  const rows = (
    await db
      .prepare(
        `SELECT name,sql FROM sqlite_schema
         WHERE type='trigger' AND name LIKE 'trg_%staging_spike%'
            OR type='trigger' AND name='trg_processed_events_acceptance_class_immutable'
         ORDER BY name`,
      )
      .all<{ name: string; sql: string }>()
  ).results;
  return Object.fromEntries(rows.map((row) => [row.name, row.sql.replace(/\s+/g, " ").trim()]));
}

describe("Phase 5 migration", () => {
  it("applies cleanly after the existing set and records the columns, trigger SQL, and index", async () => {
    const db = env.STAGING_DB;
    expect(
      (
        await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()
      ).results.map((row) => row.name),
    ).toEqual([
      "0001_initial_schema.sql",
      "0002_phase4_consumers_and_delivery.sql",
      PHASE5_MIGRATION,
      LIVE_STAGING_MIGRATION,
    ]);

    const processedColumns = (
      await db.prepare("PRAGMA table_info(processed_events)").all<{ name: string }>()
    ).results.map((row) => row.name);
    const outputColumns = (
      await db.prepare("PRAGMA table_info(discord_output_deliveries)").all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(processedColumns).toContain("acceptance_class");
    expect(outputColumns).toEqual(
      expect.arrayContaining([
        "dispatch_eligible",
        "suppression_reason",
        "suppressed_at",
        "permanent_dispatch_block",
      ]),
    );

    const definitions = await triggerDefinitions(db);
    expect(Object.keys(definitions)).toEqual([
      "trg_discord_output_staging_spike_association_update_block",
      "trg_discord_output_staging_spike_delete_block",
      "trg_discord_output_staging_spike_insert_shape",
      "trg_discord_output_staging_spike_metadata_insert_guard",
      "trg_discord_output_staging_spike_metadata_update_guard",
      "trg_discord_output_staging_spike_update_block",
      "trg_processed_events_acceptance_class_immutable",
      "trg_processed_events_staging_spike_delete_block",
      "trg_processed_events_staging_spike_insert_shape",
      "trg_processed_events_staging_spike_update_block",
    ]);
    expect(definitions.trg_processed_events_acceptance_class_immutable).toContain(
      "NEW.acceptance_class IS NOT OLD.acceptance_class",
    );
    expect(definitions.trg_processed_events_staging_spike_insert_shape).toContain(
      "NEW.finalized_at IS NOT NEW.accepted_at",
    );
    expect(definitions.trg_discord_output_staging_spike_insert_shape).toContain(
      "NEW.permanent_dispatch_block IS NOT 1",
    );
    expect(definitions.trg_discord_output_staging_spike_update_block).toContain(
      "e.event_id = OLD.event_id AND e.acceptance_class = 'staging_spike'",
    );

    const index = await db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='uq_staging_spike_output_event'",
      )
      .first<{ sql: string }>();
    expect(index?.sql.replace(/\s+/g, " ")).toContain(
      "WHERE suppression_reason = 'staging_spike_sender' AND permanent_dispatch_block = 1",
    );
  });

  it("upgrades representative Phase 4 normal rows without changing their behavior", async () => {
    const db = env.PHASE5_UPGRADE_DB;
    await applyPhase4(db);
    await seedNormalInvalid(db, "1001", "normal-delivery-1001");
    const before = await db
      .prepare(
        "SELECT status,attempts,available_at,blocked_at FROM discord_output_deliveries WHERE delivery_id='normal-delivery-1001'",
      )
      .first();

    await applyPhase5(db);
    expect(
      await db.prepare("SELECT * FROM processed_events WHERE event_id='1001'").first(),
    ).toMatchObject({
      status: "accepted_invalid",
      acceptance_class: "normal",
      finalized_at: null,
    });
    expect(
      await db
        .prepare("SELECT * FROM discord_output_deliveries WHERE delivery_id='normal-delivery-1001'")
        .first(),
    ).toMatchObject({
      ...before,
      status: "pending",
      dispatch_eligible: 1,
      suppression_reason: null,
      suppressed_at: null,
      permanent_dispatch_block: 0,
    });
    await expect(
      db
        .prepare(
          "UPDATE processed_events SET acceptance_class='staging_spike' WHERE event_id='1001'",
        )
        .run(),
    ).rejects.toThrow(/processed_event_acceptance_class_immutable/i);

    await db
      .prepare(
        `UPDATE discord_output_deliveries
         SET status='claimed',claim_token='claim-1',claim_expires_at=?1,attempts=attempts+1
         WHERE delivery_id='normal-delivery-1001'`,
      )
      .bind(STAMP)
      .run();
    await db
      .prepare(
        `UPDATE discord_output_deliveries
         SET status='pending',claim_token=NULL,claim_expires_at=NULL,last_error='synthetic_retry'
         WHERE delivery_id='normal-delivery-1001'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE discord_output_deliveries
         SET status='claimed',claim_token='claim-2',claim_expires_at=?1,attempts=attempts+1
         WHERE delivery_id='normal-delivery-1001'`,
      )
      .bind(STAMP)
      .run();
    await db
      .prepare(
        `UPDATE discord_output_deliveries
         SET status='sent',claim_token=NULL,claim_expires_at=NULL,discord_message_id='3001',sent_at=?1
         WHERE delivery_id='normal-delivery-1001'`,
      )
      .bind(STAMP)
      .run();
    await db
      .prepare(
        "UPDATE processed_events SET status='finalized',finalized_at=?1 WHERE event_id='1001'",
      )
      .bind(STAMP)
      .run();
    expect(
      await db
        .prepare(
          "SELECT status,attempts,discord_message_id FROM discord_output_deliveries WHERE delivery_id='normal-delivery-1001'",
        )
        .first(),
    ).toEqual({ status: "sent", attempts: 2, discord_message_id: "3001" });

    await seedNormalInvalid(db, "1002", "normal-delivery-1002");
    await db
      .prepare(
        "UPDATE discord_output_deliveries SET status='superseded' WHERE delivery_id='normal-delivery-1002'",
      )
      .run();
    expect(
      await db
        .prepare(
          "SELECT status FROM discord_output_deliveries WHERE delivery_id='normal-delivery-1002'",
        )
        .first("status"),
    ).toBe("superseded");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("rejects every mutation of terminal spike evidence using OLD-aware guards", async () => {
    const db = env.STAGING_DB;
    const { eventId, deliveryId } = await seedSpikeEvidence(db, "9101", "spike-delivery-9101");

    for (const update of [
      "acceptance_class='normal'",
      "status='accepted_invalid'",
      "outcome='valid'",
      "validation_reason='changed'",
      "received_at='2026-09-12T04:00:00.000Z'",
      "accepted_at='2026-09-12T04:00:00.000Z'",
      "committed_at='2026-09-12T04:00:00.000Z'",
      "finalized_at=NULL",
    ]) {
      await expect(
        db.prepare(`UPDATE processed_events SET ${update} WHERE event_id=?1`).bind(eventId).run(),
      ).rejects.toThrow(/(?:acceptance_class_immutable|staging_spike_event_immutable)/i);
    }

    for (const update of [
      "status='pending'",
      "dispatch_eligible=1",
      "suppression_reason=NULL",
      "suppressed_at=NULL",
      "permanent_dispatch_block=0",
      "blocked_at=NULL",
      "claim_token='claim'",
      "claim_expires_at='2026-09-12T04:00:00.000Z'",
      "attempts=1",
      "discord_message_id='3002'",
      "sent_at='2026-09-12T04:00:00.000Z'",
      "available_at='2026-09-12T04:00:00.000Z'",
      "last_error='synthetic'",
      "alerted_at='2026-09-12T04:00:00.000Z'",
      "content='changed'",
      "event_id=NULL",
    ]) {
      await expect(
        db
          .prepare(`UPDATE discord_output_deliveries SET ${update} WHERE delivery_id=?1`)
          .bind(deliveryId)
          .run(),
      ).rejects.toThrow(/staging_spike_output_(?:immutable|requires_spike_event)/i);
    }

    await expect(
      db
        .prepare(
          `UPDATE discord_output_deliveries SET event_id=NULL,status='pending',dispatch_eligible=1,
           suppression_reason=NULL,suppressed_at=NULL,permanent_dispatch_block=0,blocked_at=NULL,
           claim_token='claim',claim_expires_at=?1,attempts=1,discord_message_id='3003',
           sent_at=?1,available_at=?1,last_error='synthetic',alerted_at=?1
           WHERE delivery_id=?2`,
        )
        .bind(STAMP, deliveryId)
        .run(),
    ).rejects.toThrow(/staging_spike_output_immutable/i);

    await expect(
      db
        .prepare("DELETE FROM discord_output_deliveries WHERE delivery_id=?1")
        .bind(deliveryId)
        .run(),
    ).rejects.toThrow(/staging_spike_output_delete_blocked/i);
    await expect(
      db.prepare("DELETE FROM processed_events WHERE event_id=?1").bind(eventId).run(),
    ).rejects.toThrow(/staging_spike_event_delete_blocked/i);
  });

  it("rejects dispatchable inserts, relinks, and duplicate evidence for a spike event", async () => {
    const db = env.STAGING_DB;
    const { eventId } = await seedSpikeEvidence(db, "9201", "spike-delivery-9201");

    await expect(
      db
        .prepare(
          `INSERT INTO processed_events
           (event_id,kind,status,outcome,validation_reason,output_delivery_group,
            received_at,accepted_at,acceptance_class)
           VALUES ('9200','registration','accepted_invalid','invalid','player_id_not_numeric',
                   'evt:9200',?1,?1,'staging_spike')`,
        )
        .bind(STAMP)
        .run(),
    ).rejects.toThrow(/staging_spike_event_terminal_shape_required/i);

    await expect(
      db
        .prepare(
          `INSERT INTO discord_output_deliveries
          (delivery_id,delivery_group,event_id,channel_id,output_type,chunk_index,chunk_total,
           content,content_hash,nonce,created_at,updated_at)
          VALUES ('dispatchable-spike','evt:9201',?1,'200','validation_reply',1,1,
                  'unsafe','hash','nonce',?2,?2)`,
        )
        .bind(eventId, STAMP)
        .run(),
    ).rejects.toThrow(/staging_spike_output_terminal_shape_required/i);

    await seedNormalInvalid(db, "9202", "normal-delivery-9202");
    await expect(
      db
        .prepare(
          `INSERT INTO discord_output_deliveries
           (delivery_id,delivery_group,event_id,channel_id,output_type,chunk_index,chunk_total,
            content,content_hash,nonce,status,dispatch_eligible,suppression_reason,suppressed_at,
            permanent_dispatch_block,blocked_at,created_at,updated_at)
           VALUES ('normal-with-spike-metadata','evt:9202','9202','200','validation_reply',1,1,
                   'unsafe','hash','nonce','superseded',0,'staging_spike_sender',?1,1,?1,?1,?1)`,
        )
        .bind(STAMP)
        .run(),
    ).rejects.toThrow(/staging_spike_output_requires_spike_event/i);
    await expect(
      db
        .prepare(
          `UPDATE discord_output_deliveries SET event_id=?1,delivery_group='evt:9201',
           status='superseded',dispatch_eligible=0,suppression_reason='staging_spike_sender',
           suppressed_at=?2,permanent_dispatch_block=1,blocked_at=?2,available_at=NULL
           WHERE delivery_id='normal-delivery-9202'`,
        )
        .bind(eventId, STAMP)
        .run(),
    ).rejects.toThrow(/staging_spike_output_(?:relink_blocked|requires_spike_event)/i);

    await expect(
      db
        .prepare(
          `INSERT INTO discord_output_deliveries
          (delivery_id,delivery_group,event_id,operation_id,channel_id,output_type,chunk_index,
           chunk_total,content,content_hash,has_footer,nonce,status,claim_token,claim_expires_at,
           attempts,discord_message_id,sent_at,created_at,updated_at,available_at,last_error,
           blocked_at,alerted_at,dispatch_eligible,suppression_reason,suppressed_at,
           permanent_dispatch_block)
          VALUES ('duplicate-spike','evt:9201',?1,NULL,'200','validation_reply',1,1,
                  'evidence','hash',0,'nonce','superseded',NULL,NULL,0,NULL,NULL,?2,?2,
                  NULL,NULL,?2,NULL,0,'staging_spike_sender',?2,1)`,
        )
        .bind(eventId, STAMP)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it("rolls back the complete Phase 5 schema and ledger entry when migration application fails", async () => {
    const db = env.PHASE5_FAILURE_DB;
    await applyPhase4(db);
    await seedNormalInvalid(db, "9301", "normal-delivery-9301");
    const actual = env.TEST_MIGRATIONS[2];
    if (!actual) throw new Error("Phase 5 migration fixture missing");
    const failing = {
      name: "0003_phase5_atomic_failure_probe.sql",
      queries: [...actual.queries, "INSERT INTO table_that_does_not_exist(value) VALUES (1)"],
    };

    await expect(
      applyD1Migrations(db, [...env.TEST_MIGRATIONS.slice(0, 2), failing]),
    ).rejects.toThrow();
    expect(
      (
        await db.prepare("PRAGMA table_info(processed_events)").all<{ name: string }>()
      ).results.some((column) => column.name === "acceptance_class"),
    ).toBe(false);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT status FROM processed_events WHERE event_id='9301'").first(),
    ).toEqual({ status: "accepted_invalid" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(2);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("reapplication is a no-op and preserves the terminal evidence and schema", async () => {
    const db = env.PHASE5_UPGRADE_DB;
    await applyPhase4(db);
    await applyPhase5(db);
    await seedSpikeEvidence(db, "9401", "spike-delivery-9401");
    const beforeSchema = (
      await db
        .prepare(
          `SELECT type,name,sql FROM sqlite_schema
           WHERE name LIKE 'trg_%staging_spike%' OR name='trg_processed_events_acceptance_class_immutable'
              OR name='uq_staging_spike_output_event'
           ORDER BY type,name`,
        )
        .all()
    ).results;
    const beforeEvidence = await db
      .prepare(
        `SELECT e.*,d.* FROM processed_events e
         JOIN discord_output_deliveries d ON d.event_id=e.event_id WHERE e.event_id='9401'`,
      )
      .first();

    await applyPhase5(db);
    expect(
      (
        await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()
      ).results.map((row) => row.name),
    ).toEqual([
      "0001_initial_schema.sql",
      "0002_phase4_consumers_and_delivery.sql",
      PHASE5_MIGRATION,
    ]);
    expect(
      (
        await db
          .prepare(
            `SELECT type,name,sql FROM sqlite_schema
             WHERE name LIKE 'trg_%staging_spike%' OR name='trg_processed_events_acceptance_class_immutable'
                OR name='uq_staging_spike_output_event'
             ORDER BY type,name`,
          )
          .all()
      ).results,
    ).toEqual(beforeSchema);
    expect(
      await db
        .prepare(
          `SELECT e.*,d.* FROM processed_events e
           JOIN discord_output_deliveries d ON d.event_id=e.event_id WHERE e.event_id='9401'`,
        )
        .first(),
    ).toEqual(beforeEvidence);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
