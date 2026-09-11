export type GatewayCloseCategory =
  | "no_close_code"
  | "normal_session_invalidating"
  | "transport_disconnect"
  | "reconnectable"
  | "discord_recommends_new_session"
  | "fatal_configuration_or_authentication"
  | "unknown_application_close";

export interface GatewayClosePolicy {
  readonly category: GatewayCloseCategory;
  readonly discordReconnects: boolean;
  readonly documentedSessionDisposition:
    "resume" | "new_session" | "invalidated_by_normal_client_close" | "not_documented" | "halt";
  /**
   * Task 08A keeps the ADR spike invariant: any recoverable disconnect uses the existing
   * durable session when one exists. Opcode 9 d=false is handled separately and is the only
   * recovery path that durably clears a session before selecting fresh IDENTIFY.
   */
  readonly projectAction: "resume_if_available" | "halt";
}

const RECONNECTABLE = new Set([4000, 4001, 4002, 4003, 4005, 4008]);
const DOCUMENTED_NEW_SESSION = new Set([4007, 4009]);
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function classifyGatewayCloseCode(code: number | null): GatewayClosePolicy {
  if (code === null)
    return {
      category: "no_close_code",
      discordReconnects: true,
      documentedSessionDisposition: "resume",
      projectAction: "resume_if_available",
    };
  if (!Number.isInteger(code) || code < 0 || code > 65_535)
    throw new RangeError("invalid_gateway_close_code");
  if (code === 1000 || code === 1001)
    return {
      category: "normal_session_invalidating",
      discordReconnects: true,
      documentedSessionDisposition: "invalidated_by_normal_client_close",
      projectAction: "resume_if_available",
    };
  if (RECONNECTABLE.has(code))
    return {
      category: "reconnectable",
      discordReconnects: true,
      documentedSessionDisposition: "resume",
      projectAction: "resume_if_available",
    };
  if (DOCUMENTED_NEW_SESSION.has(code))
    return {
      category: "discord_recommends_new_session",
      discordReconnects: true,
      documentedSessionDisposition: "new_session",
      projectAction: "resume_if_available",
    };
  if (FATAL.has(code))
    return {
      category: "fatal_configuration_or_authentication",
      discordReconnects: false,
      documentedSessionDisposition: "halt",
      projectAction: "halt",
    };
  if (code >= 4000)
    return {
      category: "unknown_application_close",
      discordReconnects: false,
      documentedSessionDisposition: "not_documented",
      projectAction: "halt",
    };
  return {
    category: "transport_disconnect",
    discordReconnects: true,
    documentedSessionDisposition: "not_documented",
    projectAction: "resume_if_available",
  };
}
