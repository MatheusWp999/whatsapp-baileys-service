import type { WASocket } from "@whiskeysockets/baileys";

export type OutboundMediaType = "document" | "image" | "video" | "audio";

export interface OutboundMessage {
  text?: string;
  media?: {
    type: OutboundMediaType;
    data: Buffer;
    mimeType: string;
    fileName?: string;
  };
}

export async function sendWhatsAppMessage(sock: WASocket, jid: string, message: OutboundMessage) {
  const caption = message.text?.trim() || undefined;
  const media = message.media;
  if (!media) return sock.sendMessage(jid, { text: caption || "" });

  if (media.type === "image") {
    return sock.sendMessage(jid, { image: media.data, mimetype: media.mimeType, caption });
  }
  if (media.type === "video") {
    return sock.sendMessage(jid, { video: media.data, mimetype: media.mimeType, caption });
  }
  if (media.type === "audio") {
    return sock.sendMessage(jid, { audio: media.data, mimetype: media.mimeType, ptt: false });
  }
  return sock.sendMessage(jid, {
    document: media.data,
    fileName: media.fileName || "document",
    mimetype: media.mimeType,
    caption,
  });
}

export function mediaTypeFromMime(mimeType: string): OutboundMediaType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
