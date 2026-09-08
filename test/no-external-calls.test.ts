/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { deterministicUuid } from "../src/ingest/identity";
import {
  closeOutbox,
  disableCodes,
  ingestRequest,
  makeEvent,
  seedCodes,
  seedOutbox,
  uniqueId,
} from "./support/fixtures";

// Vite loads repository source at build time; no filesystem or network access in the Worker.
const sources = import.meta.glob<string>(
  ["../src/ingest/*.ts", "../src/outbox/*.ts", "../src/index.ts"],
  { query: "?raw", import: "default", eager: true },
);

it("makes zero external fetch calls throughout acceptance, inline send and scheduled send", async () => {
  const code = uniqueId();
  await seedCodes(env.STAGING_DB, [code]);
  const scheduled = await seedOutbox(env.STAGING_DB, [{}]);
  const event = makeEvent();
  const operationId = await deterministicUuid(`registration:${event.event_id}`);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("external fetch forbidden");
  });
  try {
    const response = await worker.fetch(ingestRequest(event), env, createExecutionContext());
    expect(response.status).toBe(202);
    await worker.scheduled(createScheduledController(), env, createExecutionContext());
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.STAGING_DB.prepare("SELECT status FROM outbox_jobs WHERE operation_id=?")
        .bind(scheduled.operationId)
        .first(),
    ).toEqual({ status: "enqueued" });
  } finally {
    fetch.mockRestore();
    await disableCodes(env.STAGING_DB, [code]);
    await closeOutbox(env.STAGING_DB, [operationId, scheduled.operationId]);
  }
});

it("keeps runtime ingest/outbox imports independent of provider and Discord REST modules", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  for (const [path, source] of Object.entries(sources)) {
    expect(source, path).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:provider|discord-rest)/i);
    expect(source, path).not.toMatch(/\b(?:globalThis\.)?fetch\s*\([^:)]*\)/);
    expect(source, path).not.toMatch(/\b(?:WebSocket|connect)\s*\(/);
  }
});
