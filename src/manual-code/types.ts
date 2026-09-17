export interface ManualCodeCommandEvent {
  readonly event_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly author_id: string;
  readonly author_is_bot: boolean;
  readonly author_is_system: boolean;
  readonly webhook_id: string | null;
  readonly application_id: string | null;
  readonly code: string;
  readonly created_at: string;
}

export type ManualCodeResult =
  | { readonly kind: "accepted"; readonly operationId: string }
  | { readonly kind: "duplicate_event" | "duplicate_code" };
