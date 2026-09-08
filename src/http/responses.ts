import type { IngestAcknowledgement } from "../domain/discord-event";

const ERROR_STATUS = {
  invalid_configuration: 503,
  not_found: 404,
  unauthorized: 401,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_request: 400,
  unavailable: 503,
} as const;

export function errorResponse(error: keyof typeof ERROR_STATUS): Response {
  return Response.json({ error }, { status: ERROR_STATUS[error] });
}

export function acknowledgement(status: IngestAcknowledgement): Response {
  return Response.json({ status }, { status: 202 });
}
