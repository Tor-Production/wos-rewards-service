import { ConfigurationError, loadConfig } from "./config";

/**
 * Worker entry point for the Phase 1 scaffold.
 *
 * Phase 1 authorizes no product HTTP surface, so every request receives the same generic 404.
 * The real ingestion route arrives with Phase 3. Nothing here performs Discord or Whiteout
 * Survival network I/O, and no configuration value is exposed over HTTP.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });
const INVALID_CONFIGURATION_BODY = JSON.stringify({ error: "invalid_configuration" });

export default {
  async fetch(_request, env, _ctx): Promise<Response> {
    try {
      // Fail closed: an environment that does not satisfy the safety gates serves nothing.
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        // The issue list is deliberately not echoed; the response carries no detail.
        return new Response(INVALID_CONFIGURATION_BODY, { status: 503, headers: JSON_HEADERS });
      }
      throw error;
    }

    return new Response(NOT_FOUND_BODY, { status: 404, headers: JSON_HEADERS });
  },
} satisfies ExportedHandler<Env>;
