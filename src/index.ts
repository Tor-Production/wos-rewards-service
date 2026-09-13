import { scheduledWork, queueWork } from "./runtime/handlers";
import { ConfigurationError, loadConfig } from "./config";
import { acknowledgement, errorResponse } from "./http/responses";
import { acceptRegistrationEvent } from "./ingest/acceptance";
import { verifyIngestionAuth } from "./ingest/auth";
import { classifyAcceptedAuthor } from "./ingest/author-filter";
import { newAttemptRunId } from "./ingest/identity";
import { parseRegistration } from "./ingest/registration-parser";
import { readRegistrationEvent } from "./ingest/transport";
import { INLINE_DISPATCH_LIMIT } from "./limits";
import { dispatchOutbox } from "./outbox/dispatcher";

// Named export only: Vitest binds this class through an explicit test-only Miniflare option.
// No Durable Object binding, migration, route or start trigger exists in wrangler.jsonc.
export { LocalDiscordGatewayAdapter } from "./discord/gateway/local-durable-object";

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
    const authenticated = await verifyIngestionAuth(request, config.ingestionSharedSecret);
    if (!authenticated) return errorResponse("unauthorized");
    const now = new Date();
    const transport = await readRegistrationEvent(request, now);
    if (!transport.ok) return errorResponse(transport.error);
    const event = transport.event;
    const acceptanceClass = classifyAcceptedAuthor(event, config, authenticated);
    if (acceptanceClass === null) return acknowledgement("ignored");
    const outcome = await acceptRegistrationEvent({
      db: env.STAGING_DB,
      config,
      event,
      parsed: parseRegistration(event.content, config.defaultState),
      acceptanceClass,
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
    await scheduledWork(env);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await queueWork(batch, env);
  },
} satisfies ExportedHandler<Env>;
