const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The inbound person's user ID, for per-sender rate limiting. Only
 * `message.received` events from people are limited; everything else passes.
 */
export function rateLimitedSenderFromSignedPayload(payload: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(envelope) || envelope.event_type !== "message.received") return null;
  if (!isRecord(envelope.data) || !isRecord(envelope.data.sender_handle)) return null;
  const sender = envelope.data.sender_handle;
  return sender.kind === "user" && typeof sender.id === "string" ? sender.id : null;
}

export function relayChatIdFromSignedPayload(payload: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope.data)) return null;
  const nested =
    isRecord(envelope.data.chat) ? envelope.data.chat.id : undefined;
  const candidate =
    typeof nested === "string" ? nested : envelope.data.chat_id;
  return typeof candidate === "string" && UUID.test(candidate)
    ? candidate
    : null;
}


/** The Message ID of a person's message.received in a one-to-one Chat. */
export function directInboundMessageId(payload: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(envelope) || envelope.event_type !== "message.received") return null;
  const data = envelope.data;
  if (!isRecord(data) || !isRecord(data.chat) || data.chat.is_group === true) return null;
  if (!isRecord(data.sender_handle) || data.sender_handle.kind !== "user") return null;
  return typeof data.id === "string" && UUID.test(data.id) ? data.id : null;
}
