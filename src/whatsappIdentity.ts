export type ContactIdentity = { phone: string; name: string };
export type ContactAliases = Map<string, ContactIdentity>;

export function canonicalJid(jid: string) {
  const normalized = jid.trim().toLowerCase();
  const separator = normalized.indexOf("@");
  if (separator < 0) return normalized;
  const user = normalized.slice(0, separator).split(":")[0];
  return `${user}${normalized.slice(separator)}`;
}

export function contactPhoneFromJid(remoteJid: string, aliases?: ContactAliases) {
  const jid = canonicalJid(remoteJid);
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us") && !jid.endsWith("@lid")) return "";
  const aliased = aliases?.get(jid)?.phone;
  if (aliased) return aliased.replace(/\D/g, "");
  if (jid.endsWith("@lid")) return "";
  return (jid.split("@")[0] || "").replace(/\D/g, "");
}

export function conversationJid(remoteJid: string, phone: string) {
  const jid = canonicalJid(remoteJid);
  const normalizedPhone = phone.replace(/\D/g, "");
  return jid.endsWith("@lid") && normalizedPhone ? `${normalizedPhone}@s.whatsapp.net` : jid;
}

export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "played" | "error";

export function deliveryStatusFromCode(status: unknown): DeliveryStatus | null {
  const code = Number(status);
  if (!Number.isFinite(code)) return null;
  if (code === 0) return "error";
  if (code === 1) return "pending";
  if (code === 2) return "sent";
  if (code === 3) return "delivered";
  if (code === 4) return "read";
  if (code >= 5) return "played";
  return null;
}

export function messageTimestampToIso(timestamp: unknown): string | null {
  if (timestamp == null) return null;
  let value: number;
  if (typeof timestamp === "number") {
    value = timestamp;
  } else if (typeof timestamp === "object" && !Array.isArray(timestamp)) {
    const record = timestamp as Record<string, unknown>;
    const low = Number(record.low);
    const high = Number(record.high);
    if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
    value = (high >>> 0) * 0x100000000 + (low >>> 0);
  } else {
    const parsed = Number(String(timestamp));
    if (!Number.isFinite(parsed)) return null;
    value = parsed;
  }
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
