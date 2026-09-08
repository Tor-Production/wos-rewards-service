import { ConfigurationError, loadConfig } from "./config";
import { acknowledgement, errorResponse } from "./http/responses";
import { acceptRegistrationEvent } from "./ingest/acceptance";
import { verifyIngestionAuth } from "./ingest/auth";
import { shouldAcceptAuthor } from "./ingest/author-filter";
import { newAttemptRunId } from "./ingest/identity";
import { parseRegistration } from "./ingest/registration-parser";
import { readRegistrationEvent } from "./ingest/transport";
import { INLINE_DISPATCH_LIMIT, OUTBOX_DISPATCH_SCAN_LIMIT } from "./limits";
import { dispatchOutbox } from "./outbox/dispatcher";

/** Synthetic/local Phase 3 boundary. No Discord transport, provider call or consumer. */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigurationError) return errorResponse("invalid_configuration");
      throw error;
    }
    if (new URL(request.url).pathname !== "/ingest" || request.method !== "POST")
      return errorResponse("not_found");
    if (!(await verifyIngestionAuth(request, config.ingestionSharedSecret)))
      return errorResponse("unauthorized");
    const now = new Date();
    const transport = await readRegistrationEvent(request, now);
    if (!transport.ok) return errorResponse(transport.error);
    const event = transport.event;
    if (!shouldAcceptAuthor(event, config)) return acknowledgement("ignored");
    const outcome = await acceptRegistrationEvent({
      db: env.STAGING_DB,
      config,
      event,
      parsed: parseRegistration(event.content, config.defaultState),
      now,
      attemptRunId: newAttemptRunId(),
    });
    if (outcome.kind === "rejected") return errorResponse("unavailable");
    if (outcome.kind === "duplicate") return acknowledgement("duplicate");
    if (outcome.kind === "accepted_valid") {
      try {
        await dispatchOutbox({
          db: env.STAGING_DB,
          config,
          now,
          queues: {
            registration: env.REGISTRATION_JOBS_QUEUE,
            distribution: env.CODE_FANOUT_JOBS_QUEUE,
          },
          source: {
            kind: "operation",
            operationId: outcome.operationId,
            limit: INLINE_DISPATCH_LIMIT,
          },
        });
      } catch {
        // Acceptance is already durable. The scheduled dispatcher resumes pending work.
        // Raw exceptions can contain SQL, payloads or credentials and must never be logged.
      }
    }
    return acknowledgement("accepted");
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const config = loadConfig(env);
    await dispatchOutbox({
      db: env.STAGING_DB,
      config,
      now: new Date(),
      queues: {
        registration: env.REGISTRATION_JOBS_QUEUE,
        distribution: env.CODE_FANOUT_JOBS_QUEUE,
      },
      source: { kind: "scan", limit: OUTBOX_DISPATCH_SCAN_LIMIT },
    });
  },
} satisfies ExportedHandler<Env>;
