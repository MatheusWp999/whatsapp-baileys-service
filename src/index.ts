import "dotenv/config";

import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type proto,
  type WAMessage,
  type WASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalJid,
  contactPhoneFromJid,
  conversationJid,
  deliveryStatusFromCode,
  messageTimestampToIso,
  type ContactAliases,
  type ContactIdentity,
  type DeliveryStatus,
} from "./whatsappIdentity.js";

type SessionStatus = "disconnected" | "connecting" | "qrcode" | "connected";

interface SessionState {
  vendedorId: string;
  sock: WASocket | null;
  status: SessionStatus;
  qrRaw: string | null;
  lastError: string | null;
  initializing: boolean;
  resetting: boolean;
  manualDisconnect: boolean;
  generation: number;
  reconnectTimer: NodeJS.Timeout | null;
  messagesReceived: number;
  messagesStored: number;
  messageErrors: number;
  lastMessageAt: string | null;
  lastMessagePhone: string | null;
  lastPersistError: string | null;
  historyState: "not_started" | "syncing" | "ready" | "failed";
  historyChats: number;
  historyMessages: number;
  historyLastSyncedAt: string | null;
  historyError: string | null;
  historyQueue: Promise<void>;
  messageQueue: Promise<void>;
  connectionQueue: Promise<void>;
  credentialQueue: Promise<void>;
  pendingWrites: Set<Promise<unknown>>;
  pendingHistoryFiles: Set<string>;
  contactAliases: ContactAliases;
  historyReadyTimer: NodeJS.Timeout | null;
}

interface ActiveCardLink {
  card_id: string | null;
  contact_phone: string | null;
}

interface CardPhoneMatch {
  id: string;
  telefone: string | null;
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const port = Number(process.env.PORT || 3000);
const sessionRoot = process.env.BAILEYS_SESSION_DIR || "/data/sessions";
const apiToken = (process.env.API_TOKEN || "").trim();
const linkedRetentionDays = Number(process.env.WHATSAPP_LINKED_RETENTION_DAYS || 90);
const legacyUnlinkedRetentionHours = Number(process.env.WHATSAPP_UNLINKED_RETENTION_HOURS || 0);
const unlinkedRetentionDays = Number(
  process.env.WHATSAPP_UNLINKED_RETENTION_DAYS ||
  (legacyUnlinkedRetentionHours > 0 ? legacyUnlinkedRetentionHours / 24 : linkedRetentionDays || 90),
);
const mediaMaxBytes = Number(process.env.WHATSAPP_MEDIA_MAX_BYTES || 15_000_000);

if (!process.env.WHATSAPP_UNLINKED_RETENTION_DAYS && legacyUnlinkedRetentionHours > 0) {
  logger.warn("WHATSAPP_UNLINKED_RETENTION_HOURS is deprecated; configure WHATSAPP_UNLINKED_RETENTION_DAYS");
}

type QueuedMessageEvent =
  | { kind: "message"; message: proto.IWebMessageInfo }
  | { kind: "status"; externalId: string; status: DeliveryStatus; occurredAt: string };

const sessions = new Map<string, SessionState>();
let serviceReady = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;

  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !key) return null;

  supabaseAdmin = createClient(url, key);
  return supabaseAdmin;
}

function isSupabaseConfigured() {
  return !!(process.env.SUPABASE_URL || "").trim() && !!(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function retentionCutoffIso(amount: number) {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 90;
  const ms = safeAmount * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

function normalizePhoneLast8(phone: string) {
  const digits = normalizePhone(phone);
  return digits.slice(-8);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error || "Unknown error");
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function ensureSessionState(vendedorId: string): SessionState {
  const existing = sessions.get(vendedorId);
  if (existing) return existing;

  const created: SessionState = {
    vendedorId,
    sock: null,
    status: "disconnected",
    qrRaw: null,
    lastError: null,
    initializing: false,
    resetting: false,
    manualDisconnect: false,
    generation: 0,
    reconnectTimer: null,
    messagesReceived: 0,
    messagesStored: 0,
    messageErrors: 0,
    lastMessageAt: null,
    lastMessagePhone: null,
    lastPersistError: null,
    historyState: "not_started",
    historyChats: 0,
    historyMessages: 0,
    historyLastSyncedAt: null,
    historyError: null,
    historyQueue: Promise.resolve(),
    messageQueue: Promise.resolve(),
    connectionQueue: Promise.resolve(),
    credentialQueue: Promise.resolve(),
    pendingWrites: new Set(),
    pendingHistoryFiles: new Set(),
    contactAliases: new Map(),
    historyReadyTimer: null,
  };

  sessions.set(vendedorId, created);
  return created;
}

function sessionStatusPayload(state: SessionState) {
  return {
    vendedor_id: state.vendedorId,
    instance_name: buildInstanceName(state.vendedorId),
    status: state.status,
    connected: state.status === "connected",
    qr_raw: state.qrRaw,
    last_error: state.lastError,
    supabase_configured: isSupabaseConfigured(),
    linked_retention_days: linkedRetentionDays,
    unlinked_retention_days: unlinkedRetentionDays,
    history_state: state.historyState,
    history_chats: state.historyChats,
    history_messages: state.historyMessages,
    history_last_synced_at: state.historyLastSyncedAt,
    history_error: state.historyError,
    message_metrics: {
      received: state.messagesReceived,
      stored: state.messagesStored,
      errors: state.messageErrors,
      last_message_at: state.lastMessageAt,
      last_message_phone: state.lastMessagePhone,
      last_persist_error: state.lastPersistError,
    },
  };
}

function assertValidVendedorId(vendedorId: string) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(vendedorId)) {
    throw new Error("vendedor_id is invalid");
  }
}

async function updateConnectionRow(state: SessionState) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const instanceName = buildInstanceName(state.vendedorId);

  const { error } = await supabase
    .from("whatsapp_connections")
    .upsert(
      {
        vendedor_id: state.vendedorId,
        instance_name: instanceName,
        status: state.status,
        initial_sync_state: state.historyState,
        initial_sync_completed_at: state.historyState === "ready" ? state.historyLastSyncedAt : null,
        initial_sync_error: state.historyError,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendedor_id" },
    );
  if (error) throw error;
}

async function loadConnectionHistoryState(state: SessionState) {
  const supabase = getSupabaseAdmin();
  if (!supabase || state.historyState !== "not_started") return;
  const { data, error } = await supabase
    .from("whatsapp_connections")
    .select("initial_sync_state, initial_sync_completed_at, initial_sync_error")
    .eq("vendedor_id", state.vendedorId)
    .maybeSingle();
  if (error) throw error;
  const syncState = textValue(data?.initial_sync_state);
  if (["not_started", "syncing", "ready", "failed"].includes(syncState)) {
    state.historyState = syncState as SessionState["historyState"];
  }
  state.historyLastSyncedAt = textValue(data?.initial_sync_completed_at) || null;
  state.historyError = textValue(data?.initial_sync_error) || null;
}

function buildInstanceName(vendedorId: string) {
  const prefix = (process.env.BAILEYS_INSTANCE_PREFIX || "crm-").trim().toLowerCase();
  const clean = vendedorId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `${prefix}${clean}`;
}

function sessionDirFor(vendedorId: string) {
  assertValidVendedorId(vendedorId);
  const root = path.resolve(sessionRoot);
  const sessionDir = path.resolve(root, vendedorId);
  if (!sessionDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid session path");
  }
  return sessionDir;
}

function clearReconnectTimer(state: SessionState) {
  if (!state.reconnectTimer) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

async function closeSocket(state: SessionState, logout = true) {
  const sock = state.sock;
  state.sock = null;
  if (!sock) return;

  try {
    if (logout) await timeout(sock.logout(), 5000);
    else sock.end(undefined);
  } catch {
    try {
      sock.end(undefined);
    } catch {
      // ignore socket cleanup errors
    }
  }
}

async function removeSessionDir(vendedorId: string) {
  await fs.rm(sessionDirFor(vendedorId), { recursive: true, force: true });
}

async function waitForInitialization(state: SessionState) {
  while (state.initializing) {
    await sleep(100);
  }
}

function parseDisconnectCode(error: unknown): number | null {
  if (error instanceof Boom) return error.output.statusCode;
  const rec = asRecord(error);
  const output = asRecord(rec?.output);
  const statusCode = output?.statusCode;
  if (typeof statusCode === "number") return statusCode;
  return null;
}

function extractMessageText(msg: proto.IMessage | null | undefined): string {
  if (!msg) return "";

  if (typeof msg.conversation === "string" && msg.conversation.trim()) {
    return msg.conversation.trim();
  }

  const ext = textValue(msg.extendedTextMessage?.text);
  if (ext) return ext;

  const imageCaption = textValue(msg.imageMessage?.caption);
  if (imageCaption) return imageCaption;

  const videoCaption = textValue(msg.videoMessage?.caption);
  if (videoCaption) return videoCaption;

  const documentCaption = textValue(msg.documentMessage?.caption);
  if (documentCaption) return documentCaption;

  const buttonText = textValue(msg.buttonsResponseMessage?.selectedButtonId);
  if (buttonText) return buttonText;

  const listRow = textValue(msg.listResponseMessage?.singleSelectReply?.selectedRowId);
  if (listRow) return listRow;

  return "";
}

async function resolveCardIdForPhone(vendedorId: string, phone: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("whatsapp_card_active_links")
    .select("card_id, contact_phone")
    .eq("vendedor_id", vendedorId)
    .eq("active", true);

  if (error) {
    logger.error({ error, vendedorId }, "failed to resolve active whatsapp card link");
    return null;
  }

  const normalized = normalizePhone(phone);
  for (const row of (data || []) as ActiveCardLink[]) {
    const linked = normalizePhone(row.contact_phone || "");
    if (!linked) continue;
    if (linked.endsWith(normalized) || normalized.endsWith(linked)) {
      return row.card_id || null;
    }
  }

  return null;
}

async function resolveUniqueCardIdByPhone(vendedorId: string, phone: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const normalized = normalizePhone(phone);
  if (normalized.length < 8) return null;
  const last8 = normalized.slice(-8);

  const { data, error } = await supabase
    .from("cards")
    .select("id, telefone")
    .eq("vendedor_id", vendedorId)
    .not("telefone", "is", null)
    .limit(1000);

  if (error) {
    logger.error({ error, vendedorId }, "failed to resolve card by phone");
    return null;
  }

  const matches = ((data || []) as CardPhoneMatch[]).filter((row) => {
    const cardPhone = normalizePhone(row.telefone || "");
    if (cardPhone.length < 8) return false;
    return cardPhone.endsWith(last8) || normalized.endsWith(cardPhone.slice(-8));
  });

  if (matches.length !== 1) {
    if (matches.length > 1) {
      logger.warn({ vendedorId, phone: normalized, matches: matches.length }, "multiple cards matched whatsapp phone; message not auto-linked");
    }
    return null;
  }

  return matches[0].id;
}

async function ensureActiveCardLinkForPhone(vendedorId: string, phone: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const existingCardId = await resolveCardIdForPhone(vendedorId, phone);
  if (existingCardId) return existingCardId;

  const cardId = await resolveUniqueCardIdByPhone(vendedorId, phone);
  if (!cardId) return null;

  const normalized = normalizePhone(phone);
  const { error } = await supabase.from("whatsapp_card_active_links").upsert(
    {
      card_id: cardId,
      vendedor_id: vendedorId,
      contact_phone: normalized,
      active: true,
      linked_by_user_id: null,
      linked_by_vendedor_id: vendedorId,
      linked_at: new Date().toISOString(),
      unlinked_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "card_id,vendedor_id" },
  );

  if (error) {
    logger.error({ error, vendedorId, cardId }, "failed to auto-link whatsapp phone to card");
    return null;
  }

  logger.info({ vendedorId, cardId, phone: normalized }, "auto-linked whatsapp phone to card");
  return cardId;
}

function contactPhoneFromMessage(item: proto.IWebMessageInfo, aliases?: ContactAliases) {
  const remoteJid = item.key?.remoteJid || "";
  return contactPhoneFromJid(remoteJid, aliases);
}

function historyQueueDirFor(vendedorId: string) {
  assertValidVendedorId(vendedorId);
  const root = path.resolve(sessionRoot, "..", "history-queue");
  const queueDir = path.resolve(root, vendedorId);
  if (!queueDir.startsWith(`${root}${path.sep}`)) throw new Error("Invalid history queue path");
  return queueDir;
}

function messageQueueDirFor(vendedorId: string) {
  assertValidVendedorId(vendedorId);
  const root = path.resolve(sessionRoot, "..", "message-queue");
  const queueDir = path.resolve(root, vendedorId);
  if (!queueDir.startsWith(`${root}${path.sep}`)) throw new Error("Invalid message queue path");
  return queueDir;
}

function trackPendingWrite<T>(state: SessionState, promise: Promise<T>) {
  state.pendingWrites.add(promise);
  promise.then(
    () => state.pendingWrites.delete(promise),
    () => state.pendingWrites.delete(promise),
  );
  return promise;
}

async function waitForPendingWrites(state: SessionState) {
  while (state.pendingWrites.size > 0) {
    await Promise.allSettled(Array.from(state.pendingWrites));
  }
}

async function writeQueueFile(queueDir: string, value: unknown) {
  await fs.mkdir(queueDir, { recursive: true });
  const name = `${Date.now()}-${randomUUID()}`;
  const temporaryPath = path.join(queueDir, `${name}.tmp`);
  const filePath = path.join(queueDir, `${name}.bin`);
  await fs.writeFile(temporaryPath, serialize(value));
  await fs.rename(temporaryPath, filePath);
  return filePath;
}

function clearHistoryReadyTimer(state: SessionState) {
  if (!state.historyReadyTimer) return;
  clearTimeout(state.historyReadyTimer);
  state.historyReadyTimer = null;
}

function resetHistoryState(state: SessionState) {
  clearHistoryReadyTimer(state);
  state.historyState = "not_started";
  state.historyChats = 0;
  state.historyMessages = 0;
  state.historyLastSyncedAt = null;
  state.historyError = null;
  state.historyQueue = Promise.resolve();
  state.messageQueue = Promise.resolve();
  state.pendingHistoryFiles.clear();
  state.contactAliases.clear();
}

function messageType(item: proto.IWebMessageInfo) {
  const message = item.message;
  if (message?.imageMessage) return "image";
  if (message?.videoMessage) return "video";
  if (message?.audioMessage) return "audio";
  if (message?.documentMessage) return "document";
  if (message?.stickerMessage) return "sticker";
  return "text";
}

function mediaMetadata(item: proto.IWebMessageInfo) {
  const message = item.message;
  const media = message?.imageMessage || message?.videoMessage || message?.audioMessage || message?.documentMessage || message?.stickerMessage;
  if (!media) return null;
  const mimeType = textValue(media.mimetype) || "application/octet-stream";
  const fileName = textValue("fileName" in media ? media.fileName : "");
  const declaredSize = Number(media.fileLength || 0);
  return { mimeType, fileName, declaredSize: Number.isFinite(declaredSize) ? declaredSize : 0 };
}

async function persistMessageMedia(state: SessionState, item: proto.IWebMessageInfo, externalId: string) {
  const metadata = mediaMetadata(item);
  if (!metadata || !externalId) return null;
  if (!state.sock) throw new Error("WhatsApp session is required to restore queued media");
  if (metadata.declaredSize > mediaMaxBytes) {
    logger.warn({ vendedorId: state.vendedorId, externalId, size: metadata.declaredSize }, "whatsapp media exceeds storage limit");
    return null;
  }
  const mediaStream = await downloadMediaMessage(item as WAMessage, "stream", {}, {
    logger,
    reuploadRequest: state.sock.updateMediaMessage,
  });
  const chunks: Buffer[] = [];
  let downloadedBytes = 0;
  for await (const chunk of mediaStream) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    downloadedBytes += bufferChunk.length;
    if (downloadedBytes > mediaMaxBytes) {
      mediaStream.destroy();
      throw new Error("WhatsApp media exceeds storage limit");
    }
    chunks.push(bufferChunk);
  }
  const buffer = Buffer.concat(chunks, downloadedBytes);
  const extensionFromName = path.extname(metadata.fileName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 12);
  const fallbackExtension = metadata.mimeType.startsWith("image/")
    ? ".jpg"
    : metadata.mimeType.startsWith("video/")
      ? ".mp4"
      : metadata.mimeType.startsWith("audio/")
        ? ".ogg"
        : ".bin";
  const objectPath = `${state.vendedorId}/${new Date().toISOString().slice(0, 7)}/${externalId}${extensionFromName || fallbackExtension}`;
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase persistence is required for media storage");
  const { error } = await supabase.storage.from("whatsapp-media").upload(objectPath, buffer, {
    contentType: metadata.mimeType,
    upsert: true,
  });
  if (error) throw error;
  return { path: objectPath, ...metadata, size: buffer.length };
}

function buildContactAliases(contacts: Array<Record<string, unknown>>) {
  const aliases: ContactAliases = new Map();
  for (const contact of contacts) {
    const id = canonicalJid(textValue(contact.id));
    const lid = canonicalJid(textValue(contact.lid));
    const jid = canonicalJid(textValue(contact.jid));
    const directPhone = contactPhoneFromJid(jid) || contactPhoneFromJid(id);
    const name = textValue(contact.name) || textValue(contact.notify) || textValue(contact.verifiedName);
    if (!directPhone) continue;
    const identity = { phone: directPhone, name };
    if (id) aliases.set(id, identity);
    if (lid) aliases.set(lid, identity);
    if (jid) aliases.set(jid, identity);
  }
  return aliases;
}

async function upsertChat(
  vendedorId: string,
  remoteJid: string,
  identity: ContactIdentity,
  values: Record<string, unknown>,
) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !identity.phone) return false;

  const payload = {
    vendedor_id: vendedorId,
    remote_jid: canonicalJid(remoteJid),
    contact_phone: identity.phone,
    ...(identity.name ? { contact_name: identity.name } : {}),
    ...values,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("whatsapp_chats").upsert(payload, { onConflict: "vendedor_id,remote_jid" });
  if (error) throw error;
  return true;
}

async function resolveContactIdentity(vendedorId: string, remoteJid: string, aliases?: ContactAliases) {
  const jid = canonicalJid(remoteJid);
  const alias = aliases?.get(jid);
  if (alias?.phone) return alias;

  const directPhone = contactPhoneFromJid(jid, aliases);
  if (directPhone) return { phone: directPhone, name: alias?.name || "" };
  if (!jid.endsWith("@lid")) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("whatsapp_chats")
    .select("contact_phone, contact_name")
    .eq("vendedor_id", vendedorId)
    .eq("remote_jid", jid)
    .maybeSingle();
  if (error) throw error;
  const phone = normalizePhone(data?.contact_phone || "");
  if (!phone) return null;
  const identity = { phone, name: textValue(data?.contact_name) };
  aliases?.set(jid, identity);
  return identity;
}

async function storeMessage(state: SessionState, item: proto.IWebMessageInfo, aliases?: ContactAliases) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  const vendedorId = state.vendedorId;

  const key = item.key;
  const remoteJid = canonicalJid(key?.remoteJid || "");
  const identity = await resolveContactIdentity(vendedorId, remoteJid, aliases);
  if (!identity?.phone) return false;
  const contactPhone = identity.phone;
  const canonicalConversationJid = conversationJid(remoteJid, contactPhone);

  const type = messageType(item);
  const content = extractMessageText(item.message) || `[${type}]`;
  const direction = key?.fromMe ? "out" : "in";
  const externalId = textValue(key?.id);
  const createdAt = messageTimestampToIso(item.messageTimestamp) || new Date().toISOString();
  const cardId = await ensureActiveCardLinkForPhone(vendedorId, contactPhone);
  const contactName = textValue(item.pushName) || identity.name || "";
  if (externalId && mediaMetadata(item) && !state.sock) {
    throw new Error("WhatsApp session is required to restore queued media");
  }
  const storedMedia = externalId
    ? await persistMessageMedia(state, item, externalId).catch((error) => {
        logger.warn({ error, vendedorId, externalId }, "failed to persist whatsapp media; storing message metadata only");
        return null;
      })
    : null;

  const payload = {
    vendedor_id: vendedorId,
    ...(cardId ? { card_id: cardId } : {}),
    remote_jid: canonicalConversationJid,
    source_remote_jid: remoteJid,
    contact_phone: contactPhone,
    contact_phone_last8: normalizePhoneLast8(contactPhone),
    ...(contactName ? { contact_name: contactName } : {}),
    direction,
    content,
    message_type: type,
    ...(storedMedia ? {
      media_url: storedMedia.path,
      media_mime_type: storedMedia.mimeType,
      media_file_name: storedMedia.fileName,
      media_size: storedMedia.size,
    } : {}),
    external_id: externalId || null,
    created_at: createdAt,
  };

  if (externalId) {
    const { error } = await supabase.from("whatsapp_messages").upsert(payload, { onConflict: "vendedor_id,external_id" });
    if (error) throw error;
  } else {
    const { error } = await supabase.from("whatsapp_messages").insert(payload);
    if (error) throw error;
  }

  await upsertChat(vendedorId, canonicalConversationJid, { phone: contactPhone, name: contactName }, {
    last_message_at: createdAt,
    last_message_preview: content,
    last_message_direction: direction,
    last_message_type: type,
    last_message_source: "live",
  });
  if (direction === "in") {
    const { error } = await supabase.rpc("increment_whatsapp_chat_unread", {
      p_vendedor_id: vendedorId,
      p_remote_jid: canonicalConversationJid,
      p_external_id: externalId,
    });
    if (error) throw error;
  }

  return true;
}

async function persistHistorySet(
  state: SessionState,
  payload: {
    chats?: unknown[];
    contacts?: unknown[];
    messages?: proto.IWebMessageInfo[];
    isLatest?: boolean;
  },
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase persistence is required for history synchronization");

  state.historyState = "syncing";
  state.historyError = null;
  await updateConnectionRow(state);

  const contacts = (payload.contacts || []).map(asRecord).filter((item): item is Record<string, unknown> => !!item);
  const incomingAliases = buildContactAliases(contacts);
  for (const [jid, identity] of incomingAliases) state.contactAliases.set(jid, identity);
  const aliases = state.contactAliases;
  const { data: activeLinks, error: activeLinksError } = await supabase
    .from("whatsapp_card_active_links")
    .select("card_id, contact_phone")
    .eq("vendedor_id", state.vendedorId)
    .eq("active", true);
  if (activeLinksError) throw activeLinksError;

  const cardByPhone = new Map<string, string>();
  for (const link of (activeLinks || []) as ActiveCardLink[]) {
    const phone = normalizePhone(link.contact_phone || "");
    if (phone && link.card_id) cardByPhone.set(phone, link.card_id);
  }

  const messageRows: Record<string, unknown>[] = [];
  const latestByJid = new Map<string, Record<string, unknown>>();
  const unresolvedLids: string[] = [];
  for (const item of payload.messages || []) {
    if (!item?.message) continue;
    const remoteJid = canonicalJid(item.key?.remoteJid || "");
    const identity = await resolveContactIdentity(state.vendedorId, remoteJid, aliases);
    const contactPhone = identity?.phone || "";
    const externalId = textValue(item.key?.id);
    if (!contactPhone) {
      if (remoteJid.endsWith("@lid")) unresolvedLids.push(remoteJid);
      continue;
    }
    if (!externalId) continue;
    const canonicalConversationJid = conversationJid(remoteJid, contactPhone);

    const type = messageType(item);
    const content = extractMessageText(item.message) || `[${type}]`;
    const direction = item.key?.fromMe ? "out" : "in";
    const createdAt = messageTimestampToIso(item.messageTimestamp) || new Date().toISOString();
    const contactName = textValue(item.pushName) || identity?.name || "";
    const cardId = cardByPhone.get(contactPhone) || null;
    if (mediaMetadata(item) && !state.sock) {
      throw new Error("WhatsApp session is required to restore queued history media");
    }
    const storedMedia = await persistMessageMedia(state, item, externalId).catch((error) => {
      logger.warn({ error, vendedorId: state.vendedorId, externalId }, "failed to persist whatsapp history media; storing metadata only");
      return null;
    });
    messageRows.push({
      vendedor_id: state.vendedorId,
      ...(cardId ? { card_id: cardId } : {}),
      remote_jid: canonicalConversationJid,
      source_remote_jid: remoteJid,
      contact_phone: contactPhone,
      contact_phone_last8: normalizePhoneLast8(contactPhone),
      ...(contactName ? { contact_name: contactName } : {}),
      direction,
      content,
      message_type: type,
      ...(storedMedia ? {
        media_url: storedMedia.path,
        media_mime_type: storedMedia.mimeType,
        media_file_name: storedMedia.fileName,
        media_size: storedMedia.size,
      } : {}),
      external_id: externalId,
      created_at: createdAt,
    });

    const previous = latestByJid.get(canonicalConversationJid);
    if (!previous || String(previous.last_message_at || "") < createdAt) {
      latestByJid.set(canonicalConversationJid, {
        vendedor_id: state.vendedorId,
        remote_jid: canonicalConversationJid,
        contact_phone: contactPhone,
        ...(contactName ? { contact_name: contactName } : {}),
        last_message_at: createdAt,
        last_message_preview: content,
        last_message_direction: direction,
        last_message_type: type,
        last_message_source: "history",
        updated_at: new Date().toISOString(),
      });
    }
  }

  for (let index = 0; index < messageRows.length; index += 250) {
    const { error } = await supabase
      .from("whatsapp_messages")
      .upsert(messageRows.slice(index, index + 250), { onConflict: "vendedor_id,external_id" });
    if (error) throw error;
  }

  const chatRows = new Map<string, Record<string, unknown>>(latestByJid);
  for (const rawChat of payload.chats || []) {
    const chat = asRecord(rawChat);
    const remoteJid = canonicalJid(textValue(chat?.id));
    const contactPhone = contactPhoneFromJid(remoteJid, aliases);
    if (!contactPhone) continue;
    const canonicalConversationJid = conversationJid(remoteJid, contactPhone);
    const current = chatRows.get(canonicalConversationJid) || {};
    const identity = aliases.get(remoteJid);
    chatRows.set(canonicalConversationJid, {
      vendedor_id: state.vendedorId,
      remote_jid: canonicalConversationJid,
      contact_phone: contactPhone,
      ...(identity?.name ? { contact_name: identity.name } : {}),
      unread_count: Math.max(0, Number(chat?.unreadCount || 0)),
      archived: chat?.archived === true,
      pinned: Number(chat?.pin || 0) > 0,
      ...current,
      updated_at: new Date().toISOString(),
    });
  }

  const rows = Array.from(chatRows.values());
  for (let index = 0; index < rows.length; index += 250) {
    const { error } = await supabase
      .from("whatsapp_chats")
      .upsert(rows.slice(index, index + 250), { onConflict: "vendedor_id,remote_jid" });
    if (error) throw error;
  }

  if (unresolvedLids.length > 0) {
    throw new Error(`Missing phone mapping for ${new Set(unresolvedLids).size} history LID conversation(s)`);
  }

  state.historyChats += rows.length;
  state.historyMessages += messageRows.length;
  state.historyLastSyncedAt = new Date().toISOString();
  state.historyState = "syncing";
  await updateConnectionRow(state);
  logger.info(
    { vendedorId: state.vendedorId, chats: rows.length, messages: messageRows.length, isLatest: payload.isLatest },
    "whatsapp history persisted",
  );
}

async function persistHistoryWithRetry(
  state: SessionState,
  payload: Parameters<typeof persistHistorySet>[1],
  expectedGeneration: number,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (state.generation !== expectedGeneration) throw new Error("History persistence cancelled by session reset");
    try {
      await persistHistorySet(state, payload);
      if (state.generation !== expectedGeneration) throw new Error("History persistence cancelled by session reset");
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ error, vendedorId: state.vendedorId, attempt }, "whatsapp history persistence attempt failed");
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function savePendingHistory(vendedorId: string, payload: Parameters<typeof persistHistorySet>[1]) {
  return writeQueueFile(historyQueueDirFor(vendedorId), payload);
}

function scheduleHistoryReady(state: SessionState, expectedGeneration: number, isLatest: boolean) {
  clearHistoryReadyTimer(state);
  if (!isLatest) return;
  state.historyReadyTimer = setTimeout(() => {
    state.historyReadyTimer = null;
    state.historyQueue = state.historyQueue
      .then(async () => {
        if (
          state.generation !== expectedGeneration ||
          state.historyState === "failed" ||
          state.pendingHistoryFiles.size > 0
        ) return;
        state.historyState = "ready";
        state.historyError = null;
        await updateConnectionRow(state);
      })
      .catch((error) => {
        if (state.generation !== expectedGeneration) return;
        state.historyState = "failed";
        state.historyError = errorMessage(error);
        logger.error({ error, vendedorId: state.vendedorId }, "failed to mark whatsapp history ready");
      });
  }, 5000);
}

function processPendingHistoryFile(state: SessionState, filePath: string, expectedGeneration: number) {
  state.pendingHistoryFiles.add(filePath);
  state.historyQueue = state.historyQueue
    .then(async () => {
      if (state.generation !== expectedGeneration) return;
      const payload = deserialize(await fs.readFile(filePath)) as Parameters<typeof persistHistorySet>[1];
      await persistHistoryWithRetry(state, payload, expectedGeneration);
      if (state.generation !== expectedGeneration) return;
      await fs.rm(filePath, { force: true });
      state.pendingHistoryFiles.delete(filePath);
      scheduleHistoryReady(state, expectedGeneration, payload.isLatest === true);
    })
    .catch(async (error) => {
      if (state.generation !== expectedGeneration) return;
      state.historyState = "failed";
      state.historyError = errorMessage(error);
      state.lastPersistError = state.historyError;
      state.messageErrors += 1;
      logger.error({ error, vendedorId: state.vendedorId, filePath }, "failed to persist queued whatsapp history");
      try {
        await updateConnectionRow(state);
      } catch (connectionError) {
        logger.error({ error: connectionError, vendedorId: state.vendedorId }, "failed to persist whatsapp history state");
      }
      setTimeout(() => {
        if (state.generation === expectedGeneration) processPendingHistoryFile(state, filePath, expectedGeneration);
      }, 30000);
    });
}

async function restorePendingHistory(state: SessionState, expectedGeneration: number) {
  const queueDir = historyQueueDirFor(state.vendedorId);
  await fs.mkdir(queueDir, { recursive: true });
  const files = (await fs.readdir(queueDir))
    .filter((file) => file.endsWith(".bin"))
    .sort();
  for (const file of files) processPendingHistoryFile(state, path.join(queueDir, file), expectedGeneration);
}

function isDirectMessage(item: proto.IWebMessageInfo) {
  const jid = canonicalJid(item.key?.remoteJid || "");
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us") || jid.endsWith("@lid");
}

async function savePendingMessage(vendedorId: string, message: proto.IWebMessageInfo) {
  return writeQueueFile(messageQueueDirFor(vendedorId), { kind: "message", message } satisfies QueuedMessageEvent);
}

async function savePendingStatus(
  vendedorId: string,
  externalId: string,
  status: DeliveryStatus,
  occurredAt = new Date().toISOString(),
) {
  return writeQueueFile(messageQueueDirFor(vendedorId), {
    kind: "status",
    externalId,
    status,
    occurredAt,
  } satisfies QueuedMessageEvent);
}

async function storeMessageWithRetry(
  state: SessionState,
  message: proto.IWebMessageInfo,
  expectedGeneration: number,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (state.generation !== expectedGeneration) throw new Error("Message persistence cancelled by session reset");
    try {
      const stored = await storeMessage(state, message, state.contactAliases);
      if (!stored) throw new Error("WhatsApp contact identity is not available yet");
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ error, vendedorId: state.vendedorId, attempt }, "whatsapp message persistence attempt failed");
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function storeDeliveryStatusWithRetry(
  state: SessionState,
  event: Extract<QueuedMessageEvent, { kind: "status" }>,
  expectedGeneration: number,
) {
  if (Date.now() - new Date(event.occurredAt).getTime() > 24 * 60 * 60 * 1000) return;
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase persistence is required for delivery status updates");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (state.generation !== expectedGeneration) throw new Error("Status persistence cancelled by session reset");
    try {
      const { data, error } = await supabase.rpc("update_whatsapp_message_delivery_status", {
        p_vendedor_id: state.vendedorId,
        p_external_id: event.externalId,
        p_status: event.status,
        p_occurred_at: event.occurredAt,
      });
      if (error) throw error;
      if (data !== true) throw new Error("WhatsApp message is not persisted yet");
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ error, vendedorId: state.vendedorId, attempt }, "whatsapp delivery status persistence attempt failed");
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function processPendingMessageFile(state: SessionState, filePath: string, expectedGeneration: number) {
  state.messageQueue = state.messageQueue
    .then(async () => {
      if (state.generation !== expectedGeneration) return;
      const storedValue = deserialize(await fs.readFile(filePath)) as QueuedMessageEvent | proto.IWebMessageInfo;
      const event = asRecord(storedValue)?.kind
        ? storedValue as QueuedMessageEvent
        : { kind: "message", message: storedValue as proto.IWebMessageInfo } satisfies QueuedMessageEvent;
      if (event.kind === "status") await storeDeliveryStatusWithRetry(state, event, expectedGeneration);
      else await storeMessageWithRetry(state, event.message, expectedGeneration);
      if (state.generation !== expectedGeneration) return;
      await fs.rm(filePath, { force: true });
      state.messagesStored += 1;
      state.lastPersistError = null;
    })
    .catch((error) => {
      if (state.generation !== expectedGeneration) return;
      state.messageErrors += 1;
      state.lastPersistError = errorMessage(error);
      logger.error({ error, vendedorId: state.vendedorId, filePath }, "failed to persist queued whatsapp message");
      setTimeout(() => {
        if (state.generation === expectedGeneration) processPendingMessageFile(state, filePath, expectedGeneration);
      }, 30000);
    });
}

async function restorePendingMessages(state: SessionState, expectedGeneration: number) {
  const queueDir = messageQueueDirFor(state.vendedorId);
  await fs.mkdir(queueDir, { recursive: true });
  const files = (await fs.readdir(queueDir))
    .filter((file) => file.endsWith(".bin"))
    .sort();
  for (const file of files) processPendingMessageFile(state, path.join(queueDir, file), expectedGeneration);
}

async function cleanupExpiredMessages() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const linkedCutoff = retentionCutoffIso(linkedRetentionDays);
  const unlinkedCutoff = retentionCutoffIso(unlinkedRetentionDays);

  const cleanBatch = async (linked: boolean, cutoff: string) => {
    while (true) {
      let query = supabase
        .from("whatsapp_messages")
        .select("id, media_url")
        .lt("created_at", cutoff)
        .limit(500);
      query = linked ? query.not("card_id", "is", null) : query.is("card_id", null);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) return;
      const ids = data.map((row) => row.id);
      const paths = data.map((row) => textValue(row.media_url)).filter(Boolean);
      if (paths.length > 0) {
        const { error: storageError } = await supabase.storage.from("whatsapp-media").remove(paths);
        if (storageError) throw storageError;
      }
      const { error: deleteError } = await supabase.from("whatsapp_messages").delete().in("id", ids);
      if (deleteError) throw deleteError;
      if (data.length < 500) return;
    }
  };

  try {
    await cleanBatch(true, linkedCutoff);
    await cleanBatch(false, unlinkedCutoff);
    const { error } = await supabase.rpc("cleanup_whatsapp_chat_retention", {
      p_days: Math.max(1, Math.ceil(Math.max(linkedRetentionDays, unlinkedRetentionDays))),
    });
    if (error) throw error;
  } catch (error) {
    logger.error({ error }, "failed to clean expired whatsapp data");
  }
}

function startRetentionCleanup() {
  void cleanupExpiredMessages();
  return setInterval(() => void cleanupExpiredMessages(), 60 * 60 * 1000);
}

async function scheduleReconnect(vendedorId: string, delayMs = 2500) {
  const state = ensureSessionState(vendedorId);
  if (state.reconnectTimer) return;

  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    try {
      await startSession(vendedorId);
    } catch (error) {
      logger.error({ error, vendedorId }, "reconnect failed");
      if (!state.manualDisconnect) await scheduleReconnect(vendedorId, Math.min(delayMs * 2, 60000));
    }
  }, delayMs);
}

async function startSession(vendedorId: string, forceRestart = false) {
  assertValidVendedorId(vendedorId);
  const state = ensureSessionState(vendedorId);
  if (state.resetting) throw new Error("Session reset is in progress");

  if (state.initializing) {
    for (let attempt = 0; attempt < 50 && state.initializing; attempt += 1) {
      await sleep(100);
    }
    if (state.initializing) return state;
  }

  if (state.sock && !forceRestart) return state;

  state.initializing = true;
  state.manualDisconnect = false;
  clearReconnectTimer(state);

  if (forceRestart) {
    state.generation += 1;
    state.manualDisconnect = true;
    await state.connectionQueue;
    await waitForPendingWrites(state);
    await Promise.all([state.historyQueue, state.messageQueue]);
    resetHistoryState(state);
    await closeSocket(state, true);
    state.status = "disconnected";
    state.qrRaw = null;
    state.lastError = null;
    await removeSessionDir(vendedorId);
    await updateConnectionRow(state);
    state.manualDisconnect = false;
  }

  state.generation += 1;
  const sessionGeneration = state.generation;

  try {
    const sessionDir = sessionDirFor(vendedorId);
    await fs.mkdir(sessionDir, { recursive: true });
    if (state.generation !== sessionGeneration) return state;
    await loadConnectionHistoryState(state);
    if (state.generation !== sessionGeneration) return state;

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    if (state.generation !== sessionGeneration) return state;
    const { version } = await fetchLatestBaileysVersion();
    if (state.generation !== sessionGeneration) return state;

    const sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
    });

    state.sock = sock;
    state.status = "connecting";
    state.lastError = null;
    state.qrRaw = null;
    await updateConnectionRow(state);

    sock.ev.on("creds.update", () => {
      if (state.generation !== sessionGeneration) return;
      const credentialWrite = state.credentialQueue.catch(() => undefined).then(saveCreds);
      state.credentialQueue = credentialWrite;
      void trackPendingWrite(state, credentialWrite).catch((error) => {
        if (state.generation !== sessionGeneration) return;
        state.lastError = errorMessage(error);
        logger.error({ error, vendedorId }, "failed to persist whatsapp credentials");
      });
    });

    sock.ev.on("connection.update", (update) => {
      state.connectionQueue = state.connectionQueue
        .then(async () => {
        if (state.generation !== sessionGeneration) return;

        const connection = update.connection;
        if (update.qr) {
          state.qrRaw = update.qr;
          state.status = "qrcode";
          await updateConnectionRow(state);
          if (state.generation !== sessionGeneration) return;
        }

        if (connection === "open") {
          state.status = "connected";
          state.lastError = null;
          state.qrRaw = null;
          await updateConnectionRow(state);
          if (state.generation !== sessionGeneration) return;
        }

        if (connection === "close") {
          const code = parseDisconnectCode(update.lastDisconnect?.error);
          const loggedOut = code === DisconnectReason.loggedOut;
          const shouldDeleteAuth = loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.connectionReplaced;

          state.status = "disconnected";
          state.lastError = code ? `Disconnected (${code})` : "Disconnected";
          state.sock = null;
          state.qrRaw = null;

          if (shouldDeleteAuth) {
            state.generation += 1;
            const invalidatedGeneration = state.generation;
            state.initializing = true;
            state.manualDisconnect = true;
            clearReconnectTimer(state);
            clearHistoryReadyTimer(state);
            try {
              await waitForPendingWrites(state);
              await Promise.all([state.historyQueue, state.messageQueue]);
              await removeSessionDir(vendedorId);
              if (state.generation !== invalidatedGeneration) return;
              resetHistoryState(state);
            } finally {
              state.initializing = false;
            }
            if (state.generation !== invalidatedGeneration) return;
            await updateConnectionRow(state);
            return;
          }

          const shouldReconnect = !state.manualDisconnect && !loggedOut && !shouldDeleteAuth;
          try {
            await updateConnectionRow(state);
            if (state.generation !== sessionGeneration) return;
          } finally {
            if (state.generation === sessionGeneration && shouldReconnect) await scheduleReconnect(vendedorId);
          }
        }
        })
        .catch((error) => {
          if (state.generation !== sessionGeneration) return;
          state.lastError = errorMessage(error);
          logger.error({ error, vendedorId }, "failed to process whatsapp connection update");
        });
    });

    sock.ev.on("messaging-history.set", (history) => {
      if (state.generation !== sessionGeneration) return;
      clearHistoryReadyTimer(state);
      void trackPendingWrite(state, savePendingHistory(vendedorId, history as Parameters<typeof persistHistorySet>[1]))
        .then((filePath) => processPendingHistoryFile(state, filePath, sessionGeneration))
        .catch(async (error) => {
          if (state.generation !== sessionGeneration) return;
          state.historyState = "failed";
          state.historyError = errorMessage(error);
          state.lastPersistError = state.historyError;
          state.messageErrors += 1;
          logger.error({ error, vendedorId }, "failed to persist whatsapp history");
          try {
            await updateConnectionRow(state);
          } catch (connectionError) {
            logger.error({ error: connectionError, vendedorId }, "failed to persist whatsapp history state");
          }
        });
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      if (state.generation !== sessionGeneration) return;
      const aliases = buildContactAliases(contacts as unknown as Array<Record<string, unknown>>);
      for (const [jid, identity] of aliases) state.contactAliases.set(jid, identity);
    });

    sock.ev.on("contacts.update", (contacts) => {
      if (state.generation !== sessionGeneration) return;
      const aliases = buildContactAliases(contacts as unknown as Array<Record<string, unknown>>);
      for (const [jid, identity] of aliases) state.contactAliases.set(jid, identity);
    });

    sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
      if (state.generation !== sessionGeneration) return;
      const phone = contactPhoneFromJid(jid);
      if (!phone) return;
      const identity = state.contactAliases.get(canonicalJid(jid)) || { phone, name: "" };
      state.contactAliases.set(canonicalJid(jid), identity);
      state.contactAliases.set(canonicalJid(lid), identity);
      void trackPendingWrite(state, upsertChat(vendedorId, conversationJid(lid, phone), identity, {})).catch((error) => {
        if (state.generation !== sessionGeneration) return;
        logger.error({ error, vendedorId, lid }, "failed to persist whatsapp LID mapping");
      });
    });

    sock.ev.on("chats.update", (updates) => {
      if (state.generation !== sessionGeneration) return;
      for (const update of updates) {
        const remoteJid = canonicalJid(textValue(update.id));
        void trackPendingWrite(state, (async () => {
          const identity = await resolveContactIdentity(vendedorId, remoteJid, state.contactAliases);
          if (!identity?.phone) return;
          await upsertChat(vendedorId, conversationJid(remoteJid, identity.phone), identity, {
            ...(Number.isFinite(Number(update.unreadCount)) ? { unread_count: Math.max(0, Number(update.unreadCount)) } : {}),
            ...(typeof update.archived === "boolean" ? { archived: update.archived } : {}),
          });
        })()).catch((error) => logger.error({ error, vendedorId, remoteJid }, "failed to persist whatsapp chat update"));
      }
    });

    sock.ev.on("messages.upsert", (payload) => {
      if (state.generation !== sessionGeneration) return;

      for (const message of payload.messages || []) {
        if (!message?.message || !isDirectMessage(message)) continue;
        state.messagesReceived += 1;
        state.lastMessageAt = new Date().toISOString();
        state.lastMessagePhone = contactPhoneFromMessage(message, state.contactAliases) || state.lastMessagePhone;
        void trackPendingWrite(state, savePendingMessage(vendedorId, message))
          .then((filePath) => processPendingMessageFile(state, filePath, sessionGeneration))
          .catch((error) => {
            if (state.generation !== sessionGeneration) return;
            state.messageErrors += 1;
            state.lastPersistError = errorMessage(error);
            logger.error({ error, vendedorId }, "failed to queue whatsapp message");
          });
      }
    });

    sock.ev.on("messages.update", (updates) => {
      if (state.generation !== sessionGeneration) return;
      for (const item of updates) {
        const externalId = textValue(item.key?.id);
        const remoteJid = canonicalJid(item.key?.remoteJid || "");
        const status = deliveryStatusFromCode(item.update?.status);
        if (!externalId || !status || !["@s.whatsapp.net", "@c.us", "@lid"].some((suffix) => remoteJid.endsWith(suffix))) continue;
        void trackPendingWrite(state, savePendingStatus(vendedorId, externalId, status))
          .then((filePath) => processPendingMessageFile(state, filePath, sessionGeneration))
          .catch((error) => logger.error({ error, vendedorId, externalId }, "failed to queue whatsapp delivery status"));
      }
    });

    sock.ev.on("message-receipt.update", (updates) => {
      if (state.generation !== sessionGeneration) return;
      for (const item of updates) {
        const externalId = textValue(item.key?.id);
        const remoteJid = canonicalJid(item.key?.remoteJid || "");
        const receipt = asRecord(item.receipt);
        const status: DeliveryStatus | null = receipt?.playedTimestamp
          ? "played"
          : receipt?.readTimestamp
            ? "read"
            : receipt?.deliveredTimestamp
              ? "delivered"
              : null;
        if (!externalId || !status || !["@s.whatsapp.net", "@c.us", "@lid"].some((suffix) => remoteJid.endsWith(suffix))) continue;
        void trackPendingWrite(state, savePendingStatus(vendedorId, externalId, status))
          .then((filePath) => processPendingMessageFile(state, filePath, sessionGeneration))
          .catch((error) => logger.error({ error, vendedorId, externalId }, "failed to queue whatsapp message receipt"));
      }
    });

    await restorePendingHistory(state, sessionGeneration);
    await restorePendingMessages(state, sessionGeneration);
    return state;
  } catch (error) {
    if (state.generation === sessionGeneration) {
      state.status = "disconnected";
      state.qrRaw = null;
      state.lastError = errorMessage(error);
      await closeSocket(state, false);
    }
    throw error;
  } finally {
    state.initializing = false;
  }
}

async function waitForQrOrConnection(state: SessionState, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.qrRaw || state.status === "connected" || state.status === "disconnected") return state;
    await sleep(250);
  }
  return state;
}

async function resetSession(vendedorId: string, reason = "manual_reset") {
  assertValidVendedorId(vendedorId);
  const state = ensureSessionState(vendedorId);
  if (state.resetting) throw new Error("Session reset is already in progress");
  state.resetting = true;
  try {
    state.generation += 1;
    state.manualDisconnect = true;
    clearReconnectTimer(state);
    await waitForInitialization(state);
    await closeSocket(state, true);
    await state.connectionQueue;
    await waitForPendingWrites(state);
    await Promise.all([state.historyQueue, state.messageQueue]);
    await removeSessionDir(vendedorId);

    state.status = "disconnected";
    state.qrRaw = null;
    state.lastError = null;
    state.initializing = false;
    resetHistoryState(state);
    logger.info({ vendedorId, reason }, "session auth state removed");
    await updateConnectionRow(state);
    return state;
  } finally {
    state.resetting = false;
  }
}

async function stopAllSessions(reason: string) {
  const states = Array.from(sessions.values());
  await Promise.all(
    states.map(async (state) => {
      state.generation += 1;
      state.manualDisconnect = true;
      clearReconnectTimer(state);
      await state.connectionQueue;
      await waitForPendingWrites(state);
      await Promise.all([state.historyQueue, state.messageQueue]);
      await waitForInitialization(state);
      await closeSocket(state, false);
      state.status = "disconnected";
      state.qrRaw = null;
      state.lastError = reason;
      await updateConnectionRow(state);
    }),
  );
}

async function disconnectSession(vendedorId: string) {
  assertValidVendedorId(vendedorId);
  return resetSession(vendedorId, "disconnect_requested");
}

async function syncHistory(vendedorId: string) {
  const state = await startSession(vendedorId);
  if (!state.sock || state.status !== "connected") {
    throw new Error("Session is not connected");
  }
  return {
    synced: state.historyMessages,
    chats: state.historyChats,
    history_state: state.historyState,
    history_last_synced_at: state.historyLastSyncedAt,
    history_error: state.historyError,
  };
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const apiKey = textValue(req.headers["x-api-key"]);

  if (bearer === apiToken || apiKey === apiToken) {
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

function requireVendedorId(req: Request, res: Response, options: { validateInstanceName?: boolean } = {}) {
  const validateInstanceName = options.validateInstanceName !== false;
  const vendedorId = textValue(req.query.vendedor_id) || textValue(req.body?.vendedor_id) || textValue(req.headers["x-vendedor-id"]);
  if (!vendedorId) {
    res.status(400).json({ error: "vendedor_id is required" });
    return null;
  }

  try {
    assertValidVendedorId(vendedorId);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "vendedor_id is invalid" });
    return null;
  }

  const instanceName = textValue(req.query.instance_name) || textValue(req.body?.instance_name) || textValue(req.headers["x-instance-name"]);
  if (validateInstanceName && instanceName && instanceName !== buildInstanceName(vendedorId)) {
    res.status(400).json({ error: "instance_name does not match vendedor_id" });
    return null;
  }

  return vendedorId;
}

app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  const metrics = Array.from(sessions.values()).map((state) => ({
    vendedor_id: state.vendedorId,
    status: state.status,
    received: state.messagesReceived,
    stored: state.messagesStored,
    errors: state.messageErrors,
    last_message_at: state.lastMessageAt,
    last_message_phone: state.lastMessagePhone,
    last_persist_error: state.lastPersistError,
  }));

  res.status(serviceReady ? 200 : 503).json({
    ok: serviceReady,
    ready: serviceReady,
    service: "whatsapp-baileys-service",
    supabase_configured: isSupabaseConfigured(),
    linked_retention_days: linkedRetentionDays,
    unlinked_retention_days: unlinkedRetentionDays,
    sessions_total: metrics.length,
    sessions_connected: metrics.filter((item) => item.status === "connected").length,
    ts: new Date().toISOString(),
  });
});

app.use(authMiddleware);

app.get("/session/status", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const state = ensureSessionState(vendedorId);
    if (!state.sock && state.status === "disconnected") {
      await startSession(vendedorId);
    }

    const payload = sessionStatusPayload(state);
    let qrImageDataUrl: string | null = null;
    if (state.qrRaw) {
      qrImageDataUrl = await QRCode.toDataURL(state.qrRaw);
    }

    res.json({ ...payload, qr_image_data_url: qrImageDataUrl });
  } catch (error) {
    logger.error({ error }, "session/status failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/session/refresh-qr", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const forceNew = req.body?.force_new === true;
    const state = await startSession(vendedorId, forceNew);
    await waitForQrOrConnection(state);
    const payload = sessionStatusPayload(state);
    const qrImageDataUrl = state.qrRaw ? await QRCode.toDataURL(state.qrRaw) : null;

    res.json({ ...payload, qr_image_data_url: qrImageDataUrl });
  } catch (error) {
    logger.error({ error }, "session/refresh-qr failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/session/disconnect", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const state = await disconnectSession(vendedorId);
    res.json(sessionStatusPayload(state));
  } catch (error) {
    logger.error({ error }, "session/disconnect failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/session/reset", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const reason = textValue(req.body?.reason) || "manual_reset";
    const state = await resetSession(vendedorId, reason);
    res.json(sessionStatusPayload(state));
  } catch (error) {
    logger.error({ error }, "session/reset failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/session/logout", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const state = await resetSession(vendedorId, "logout_requested");
    res.json(sessionStatusPayload(state));
  } catch (error) {
    logger.error({ error }, "session/logout failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/message/send", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res, { validateInstanceName: false });
    if (!vendedorId) return;

    const phone = normalizePhone(textValue(req.body?.phone) || textValue(req.body?.contact_phone));
    const text = textValue(req.body?.text) || textValue(req.body?.content);
    const attachment = req.body?.attachment && typeof req.body.attachment === "object" ? req.body.attachment : null;
    const attachmentBase64 = textValue(attachment?.base64);
    const attachmentFileName = textValue(attachment?.file_name) || textValue(attachment?.fileName) || "via-de-venda.pdf";
    const attachmentMimeType = textValue(attachment?.mime_type) || textValue(attachment?.mimeType) || "application/pdf";
    if (!phone || phone.length < 8) {
      res.status(400).json({ error: "phone is invalid" });
      return;
    }
    if (!text && !attachmentBase64) {
      res.status(400).json({ error: "text or attachment is required" });
      return;
    }
    if (attachmentBase64 && !/^(image\/|video\/|audio\/|application\/|text\/plain)/i.test(attachmentMimeType)) {
      res.status(400).json({ error: "attachment mime type is invalid" });
      return;
    }
    if (attachmentBase64 && (!/^[a-zA-Z0-9+/=\r\n]+$/.test(attachmentBase64) || attachmentBase64.length > 20_000_000)) {
      res.status(400).json({ error: "attachment payload is invalid or too large" });
      return;
    }

    const state = await startSession(vendedorId);
    if (!state.sock || state.status !== "connected") {
      res.status(409).json({ error: "session is not connected" });
      return;
    }

    const jid = `${phone}@s.whatsapp.net`;
    const attachmentBuffer = attachmentBase64 ? Buffer.from(attachmentBase64, "base64") : null;
    const result = attachmentBuffer
      ? attachmentMimeType.startsWith("image/")
        ? await state.sock.sendMessage(jid, { image: attachmentBuffer, mimetype: attachmentMimeType, caption: text || undefined })
        : attachmentMimeType.startsWith("video/")
          ? await state.sock.sendMessage(jid, { video: attachmentBuffer, mimetype: attachmentMimeType, caption: text || undefined })
          : attachmentMimeType.startsWith("audio/")
            ? await state.sock.sendMessage(jid, { audio: attachmentBuffer, mimetype: attachmentMimeType, ptt: false })
            : await state.sock.sendMessage(jid, {
                document: attachmentBuffer,
                fileName: attachmentFileName,
                mimetype: attachmentMimeType,
                caption: text || undefined,
              })
      : await state.sock.sendMessage(jid, { text });

    const externalId = textValue((result as any)?.key?.id) || null;

    res.json({ success: true, external_id: externalId });
  } catch (error) {
    logger.error({ error }, "message/send failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

app.post("/history/sync", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const result = await syncHistory(vendedorId);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error({ error }, "history/sync failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

const retentionCleanupTimer = startRetentionCleanup();

async function restorePersistedSessions() {
  const listDirectories = async (root: string) => {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const sessionIds = await listDirectories(path.resolve(sessionRoot));
  const historyQueueIds = await listDirectories(path.resolve(sessionRoot, "..", "history-queue"));
  const messageQueueIds = await listDirectories(path.resolve(sessionRoot, "..", "message-queue"));
  const vendedorIds = Array.from(new Set([...sessionIds, ...historyQueueIds, ...messageQueueIds]));
  for (const vendedorId of vendedorIds) {
    try {
      assertValidVendedorId(vendedorId);
      if (sessionIds.includes(vendedorId)) {
        await startSession(vendedorId);
      } else {
        const state = ensureSessionState(vendedorId);
        await loadConnectionHistoryState(state);
        await restorePendingHistory(state, state.generation);
        await restorePendingMessages(state, state.generation);
      }
    } catch (error) {
      logger.error({ error, vendedorId }, "failed to restore persisted whatsapp session");
    }
  }
  logger.info({ sessions: sessionIds.length, queue_owners: vendedorIds.length }, "persisted whatsapp state restored");
}

if (!apiToken) throw new Error("API_TOKEN is required");
if (!isSupabaseConfigured()) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const server = app.listen(port, async () => {
  try {
    await fs.mkdir(path.resolve(sessionRoot), { recursive: true });
    await restorePersistedSessions();
    serviceReady = true;
    logger.info({ port, sessionRoot }, "whatsapp-baileys-service started");
  } catch (error) {
    logger.fatal({ error }, "whatsapp-baileys-service failed to initialize");
    server.close(() => process.exit(1));
  }
});

app.post("/chat/read", async (req, res) => {
  try {
    const vendedorId = requireVendedorId(req, res, { validateInstanceName: false });
    if (!vendedorId) return;
    const phone = normalizePhone(textValue(req.body?.phone) || textValue(req.body?.contact_phone));
    if (phone.length < 8) {
      res.status(400).json({ error: "phone is invalid" });
      return;
    }
    const state = await startSession(vendedorId);
    if (!state.sock || state.status !== "connected") {
      res.status(409).json({ error: "session is not connected" });
      return;
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("Supabase persistence is required");
    const { data: rows, error: messageError } = await supabase
      .from("whatsapp_messages")
      .select("external_id, remote_jid, source_remote_jid")
      .eq("vendedor_id", vendedorId)
      .eq("contact_phone", phone)
      .eq("direction", "in")
      .not("external_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (messageError) throw messageError;
    const keys = (rows || []).map((row) => ({
      id: row.external_id as string,
      remoteJid: textValue(row.source_remote_jid) || textValue(row.remote_jid) || `${phone}@s.whatsapp.net`,
      fromMe: false,
    }));
    if (keys.length > 0) await state.sock.readMessages(keys);
    const { error: chatError } = await supabase.rpc("mark_whatsapp_chat_read", {
      p_vendedor_id: vendedorId,
      p_contact_phone: phone,
      p_external_ids: keys.map((key) => key.id),
    });
    if (chatError) throw chatError;
    res.json({ success: true, read: keys.length });
  } catch (error) {
    logger.error({ error }, "chat/read failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down whatsapp-baileys-service");
  serviceReady = false;
  clearInterval(retentionCleanupTimer);
  server.close(async () => {
    try {
      await stopAllSessions(`shutdown:${signal}`);
      process.exit(0);
    } catch (error) {
      logger.error({ error }, "failed to stop sessions during shutdown");
      process.exit(1);
    }
  });

  setTimeout(() => process.exit(1), 15000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
