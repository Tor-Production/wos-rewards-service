/** Raw transport payload; business validation belongs exclusively to the Worker. */
export interface RegistrationMessageEvent {
  readonly event_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly author_id: string;
  readonly author_is_bot: boolean;
  readonly author_is_system: boolean;
  readonly webhook_id: string | null;
  readonly application_id: string | null;
  readonly content: string;
  readonly created_at: string;
}

export type IngestAcknowledgement = "accepted" | "duplicate" | "ignored";

/**
 * An adapter owns the Discord connection, filters guild/channel/authors and forwards raw
 * content even if registration syntax is invalid. No adapter ships until ADR 0001 is
 * completed or waived; this forwarding contract does not select a topology.
 */
export interface DiscordEventSource {
  forward(event: RegistrationMessageEvent): Promise<IngestAcknowledgement>;
}
