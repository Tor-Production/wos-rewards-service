import { DISCOVERY_MAX_BODY_BYTES, isFollowCodeEvent } from "../shared/discord-follow";
import { discordFollowSource } from "./discovery/discord-follow";
import { readBoundedEvent } from "./manual-code/transport";
import { openDiscoveredDistribution } from "./operations/distribution";
import { scheduledWork, queueWork } from "./runtime/handlers";
import { ConfigurationError, loadConfig } from "./config";
import { acknowledgement, errorResponse, manualCodeResponse } from "./http/responses";
import { acceptRegistrationEvent } from "./ingest/acceptance";
import { verifyIngestionAuth } from "./ingest/auth";
import { classifyAcceptedAuthor } from "./ingest/author-filter";
import { newAttemptRunId } from "./ingest/identity";
import { parseRegistration } from "./ingest/registration-parser";
import { readRegistrationEvent } from "./ingest/transport";
import { INLINE_DISPATCH_LIMIT } from "./limits";
import { readManualCodeCommand } from "./manual-code/transport";
import { openDistribution } from "./operations/distribution";
import { dispatchOutbox } from "./outbox/dispatcher";

// Named export only: Vitest binds this class through an explicit test-only Miniflare option.
// No Durable Object binding, migration, route or start trigger exists in wrangler.jsonc.
export { LocalDiscordGatewayAdapter } from "./discord/gateway/local-durable-object";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigurationError) return errorResponse("invalid_configuration");
      throw error;
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("not_found");
    if (path === "/discovered-code") return handleDiscoveredCode(request, env, config);
    if (path === "/manual-code") return handleManualCode(request, env, config);
    if (path !== "/ingest") return errorResponse("not_found");
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

async function handleManualCode(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  const authenticated = await verifyIngestionAuth(request, config.ingestionSharedSecret);
  if (!authenticated) return manualCodeResponse("unauthorized");
  const now = new Date();
  const command = await readManualCodeCommand(request, now);
  if (!command) return manualCodeResponse("ignored");
  if (
    command.guild_id !== config.discordGuildId ||
    command.channel_id !== config.discordMvpAdminChannelId ||
    command.author_is_bot ||
    command.author_is_system ||
    command.webhook_id !== null ||
    command.application_id !== null
  )
    return manualCodeResponse("ignored");
  if (!config.discordMvpAdminUserAllowlist.includes(command.author_id))
    return manualCodeResponse("unauthorized");
  try {
    const result = await openDistribution(env.STAGING_DB, config, command.code, now, command);
    return manualCodeResponse(result.kind === "accepted" ? "accepted" : "duplicate");
  } catch {
    return manualCodeResponse("unavailable");
  }
}

async function handleDiscoveredCode(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  if (!(await verifyIngestionAuth(request, config.ingestionSharedSecret)))
    return manualCodeResponse("unauthorized");
  if (!config.codeDiscoveryEnabled || !config.followSource) return manualCodeResponse("ignored");
  const now = new Date();
  const event = await readBoundedEvent(request, DISCOVERY_MAX_BODY_BYTES, (value) =>
    isFollowCodeEvent(value, config.followSource, now),
  );
  const parsed = discordFollowSource.candidate(event, config.followSource, now);
  if (!parsed) return manualCodeResponse("ignored");
  try {
    const result = await openDiscoveredDistribution(
      env.STAGING_DB,
      config,
      parsed.event,
      parsed.candidate,
      now,
    );
    return manualCodeResponse(result.kind === "accepted" ? "accepted" : "duplicate");
  } catch {
    return manualCodeResponse("unavailable");
  }
}
