import "dotenv/config";

import path from "node:path";
import fs from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pino from "pino";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type proto,
  type WASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SessionStatus = "disconnected" | "connecting" | "qrcode" | "connected";

interface SessionState {
  vendedorId: string;
  sock: WASocket | null;
  status: SessionStatus;
  qrRaw: string | null;
  lastError: string | null;
  initializing: boolean;
  manualDisconnect: boolean;
  generation: number;
  reconnectTimer: NodeJS.Timeout | null;
}

interface HistorySyncInput {
  vendedorId: string;
  contactPhone: string;
  limit: number;
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
const unlinkedRetentionHours = Number(process.env.WHATSAPP_UNLINKED_RETENTION_HOURS || 24);
const inboundWebhookUrl = (process.env.WHATSAPP_INBOUND_WEBHOOK_URL || process.env.WEBHOOK_URL || "").trim();
const inboundWebhookSecret = (process.env.WHATSAPP_INBOUND_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || apiToken).trim();

const sessions = new Map<string, SessionState>();

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

function isInboundWebhookConfigured() {
  return !!inboundWebhookUrl;
}

function retentionCutoffIso(amount: number, unit: "days" | "hours") {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : unit === "days" ? 90 : 24;
  const ms = unit === "days" ? safeAmount * 24 * 60 * 60 * 1000 : safeAmount * 60 * 60 * 1000;
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
    manualDisconnect: false,
    generation: 0,
    reconnectTimer: null,
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
    inbound_webhook_configured: isInboundWebhookConfigured(),
    linked_retention_days: linkedRetentionDays,
    unlinked_retention_hours: unlinkedRetentionHours,
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

  await supabase
    .from("whatsapp_connections")
    .upsert(
      {
        vendedor_id: state.vendedorId,
        instance_name: instanceName,
        status: state.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendedor_id" },
    );
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

async function waitForInitialization(state: SessionState, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (state.initializing && Date.now() - startedAt < timeoutMs) {
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

function messageTimestampToIso(timestamp: unknown): string | null {
  if (timestamp == null) return null;

  let value: number;
  if (typeof timestamp === "number") {
    value = timestamp;
  } else {
    const maybeNumber = Number(String(timestamp));
    if (!Number.isFinite(maybeNumber)) return null;
    value = maybeNumber;
  }

  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
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

async function resolveRequestedCardIdForPhone(vendedorId: string, phone: string, requestedCardId: string | null) {
  const linkedCardId = await ensureActiveCardLinkForPhone(vendedorId, phone);
  if (!linkedCardId) return null;
  if (requestedCardId && requestedCardId !== linkedCardId) return null;
  return requestedCardId || linkedCardId;
}

function isDirectChatJid(remoteJid: string) {
  return remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@c.us");
}

function contactPhoneFromJid(remoteJid: string) {
  if (!isDirectChatJid(remoteJid)) return "";
  return normalizePhone((remoteJid.split("@")[0] || remoteJid || "").trim());
}

async function storeMessage(vendedorId: string, item: proto.IWebMessageInfo) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const key = item.key;
  const remoteJid = key?.remoteJid || "";
  const contactPhone = contactPhoneFromJid(remoteJid);
  if (!contactPhone) return false;

  const content = extractMessageText(item.message) || "[media]";
  const direction = key?.fromMe ? "out" : "in";
  const externalId = textValue(key?.id);
  const createdAt = messageTimestampToIso(item.messageTimestamp) || new Date().toISOString();
  const messageType = content === "[media]" ? "media" : "text";
  const cardId = await ensureActiveCardLinkForPhone(vendedorId, contactPhone);

  const payload = {
    vendedor_id: vendedorId,
    card_id: cardId,
    contact_phone: contactPhone,
    contact_phone_last8: normalizePhoneLast8(contactPhone),
    contact_name: textValue(item.pushName),
    direction,
    content,
    message_type: messageType,
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

  return true;
}

async function forwardInboundMessageToWebhook(vendedorId: string, item: proto.IWebMessageInfo) {
  if (!inboundWebhookUrl) return false;

  const payload = {
    vendedor_id: vendedorId,
    instance_name: buildInstanceName(vendedorId),
    messages: [
      {
        key: item.key,
        message: item.message,
        messageTimestamp: item.messageTimestamp ? String(item.messageTimestamp) : undefined,
        pushName: item.pushName || "",
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-vendedor-id": vendedorId,
    "x-instance-name": buildInstanceName(vendedorId),
  };

  if (inboundWebhookSecret) {
    headers.Authorization = `Bearer ${inboundWebhookSecret}`;
    headers["x-api-key"] = inboundWebhookSecret;
    headers["x-baileys-webhook-secret"] = inboundWebhookSecret;
  }

  const response = await fetch(inboundWebhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Inbound webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return true;
}

async function cleanupExpiredMessages() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const linkedCutoff = retentionCutoffIso(linkedRetentionDays, "days");
  const unlinkedCutoff = retentionCutoffIso(unlinkedRetentionHours, "hours");

  const { error: linkedError } = await supabase
    .from("whatsapp_messages")
    .delete()
    .not("card_id", "is", null)
    .lt("created_at", linkedCutoff);

  if (linkedError) {
    logger.error({ error: linkedError }, "failed to clean linked whatsapp messages");
  }

  const { error: unlinkedError } = await supabase
    .from("whatsapp_messages")
    .delete()
    .is("card_id", null)
    .lt("created_at", unlinkedCutoff);

  if (unlinkedError) {
    logger.error({ error: unlinkedError }, "failed to clean unlinked whatsapp messages");
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
    }
  }, delayMs);
}

async function startSession(vendedorId: string, forceRestart = false) {
  assertValidVendedorId(vendedorId);
  const state = ensureSessionState(vendedorId);

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
    await closeSocket(state, true);
    state.status = "disconnected";
    state.qrRaw = null;
    state.lastError = null;
    await removeSessionDir(vendedorId);
    state.manualDisconnect = false;
  }

  state.generation += 1;
  const sessionGeneration = state.generation;

  try {
    const sessionDir = sessionDirFor(vendedorId);
    await fs.mkdir(sessionDir, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger,
      browser: ["CRM", "Chrome", "1.0.0"],
      syncFullHistory: true,
      markOnlineOnConnect: false,
    });

    state.sock = sock;
    state.status = "connecting";
    state.lastError = null;
    state.qrRaw = null;
    await updateConnectionRow(state);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      if (state.generation !== sessionGeneration) return;

      const connection = update.connection;
      if (update.qr) {
        state.qrRaw = update.qr;
        state.status = "qrcode";
        await updateConnectionRow(state);
      }

      if (connection === "open") {
        state.status = "connected";
        state.lastError = null;
        state.qrRaw = null;
        await updateConnectionRow(state);
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
          await removeSessionDir(vendedorId);
        }

        await updateConnectionRow(state);

        if (!state.manualDisconnect && !loggedOut && !shouldDeleteAuth) {
          await scheduleReconnect(vendedorId);
        }
      }
    });

    sock.ev.on("messages.upsert", async (payload) => {
      if (state.generation !== sessionGeneration) return;

      try {
        for (const message of payload.messages || []) {
          if (!message?.message) continue;
          const results = await Promise.allSettled([
            storeMessage(vendedorId, message),
            forwardInboundMessageToWebhook(vendedorId, message),
          ]);

          for (const result of results) {
            if (result.status === "rejected") {
              logger.error({ error: result.reason, vendedorId }, "failed to persist inbound whatsapp message");
            }
          }
        }
      } catch (error) {
        logger.error({ error, vendedorId }, "failed to store messages.upsert");
      }
    });

    return state;
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
  state.generation += 1;
  state.manualDisconnect = true;
  clearReconnectTimer(state);
  await waitForInitialization(state);
  await closeSocket(state, true);
  await removeSessionDir(vendedorId);

  state.status = "disconnected";
  state.qrRaw = null;
  state.lastError = null;
  state.initializing = false;
  logger.info({ vendedorId, reason }, "session auth state removed");
  await updateConnectionRow(state);
  return state;
}

async function stopAllSessions(reason: string) {
  const states = Array.from(sessions.values());
  await Promise.all(
    states.map(async (state) => {
      state.generation += 1;
      state.manualDisconnect = true;
      clearReconnectTimer(state);
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

async function syncHistory(input: HistorySyncInput) {
  const state = await startSession(input.vendedorId);
  const sock = state.sock;
  if (!sock) {
    throw new Error("Session is not initialized");
  }

  if (typeof (sock as any).fetchMessagesFromWAWeb !== "function") {
    return { synced: 0, skipped: true, reason: "fetchMessagesFromWAWeb_not_available" };
  }

  const jid = `${normalizePhone(input.contactPhone)}@s.whatsapp.net`;
  const messages: proto.IWebMessageInfo[] = await (sock as any).fetchMessagesFromWAWeb(jid, input.limit, undefined);

  let synced = 0;
  for (const msg of messages || []) {
    if (!msg?.message) continue;
    const stored = await storeMessage(input.vendedorId, msg);
    if (stored) synced += 1;
  }

  return { synced, skipped: false };
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!apiToken) return next();

  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const apiKey = textValue(req.headers["x-api-key"]);

  if (bearer === apiToken || apiKey === apiToken) {
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

function requireVendedorId(req: Request, res: Response) {
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
  if (instanceName && instanceName !== buildInstanceName(vendedorId)) {
    res.status(400).json({ error: "instance_name does not match vendedor_id" });
    return null;
  }

  return vendedorId;
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-baileys-service",
    supabase_configured: isSupabaseConfigured(),
    inbound_webhook_configured: isInboundWebhookConfigured(),
    linked_retention_days: linkedRetentionDays,
    unlinked_retention_hours: unlinkedRetentionHours,
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

    const forceNew = req.body?.force_new !== false;
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
    const vendedorId = requireVendedorId(req, res);
    if (!vendedorId) return;

    const phone = normalizePhone(textValue(req.body?.phone) || textValue(req.body?.contact_phone));
    const text = textValue(req.body?.text) || textValue(req.body?.content);
    if (!phone || phone.length < 8) {
      res.status(400).json({ error: "phone is invalid" });
      return;
    }
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const state = await startSession(vendedorId);
    if (!state.sock || state.status !== "connected") {
      res.status(409).json({ error: "session is not connected" });
      return;
    }

    const jid = `${phone}@s.whatsapp.net`;
    const result = await state.sock.sendMessage(jid, { text });

    const externalId = textValue((result as any)?.key?.id) || null;
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const requestedCardId = textValue(req.body?.card_id) || null;
      const cardId = await resolveRequestedCardIdForPhone(vendedorId, phone, requestedCardId);
      const payload = {
        vendedor_id: vendedorId,
        card_id: cardId,
        contact_phone: phone,
        contact_phone_last8: normalizePhoneLast8(phone),
        contact_name: "",
        direction: "out",
        content: text,
        message_type: "text",
        external_id: externalId,
        sent_by_user_id: null,
        sent_as_vendedor_id: vendedorId,
        intervention: false,
      };

      if (cardId) {
        if (externalId) {
          const { error } = await supabase.from("whatsapp_messages").upsert(payload, { onConflict: "vendedor_id,external_id" });
          if (error) throw error;
        } else {
          const { error } = await supabase.from("whatsapp_messages").insert(payload);
          if (error) throw error;
        }
      }
    }

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

    const contactPhone = normalizePhone(textValue(req.body?.contact_phone));
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.min(Math.max(Math.trunc(Number(req.body.limit)), 1), 400) : 120;

    if (!contactPhone || contactPhone.length < 8) {
      res.status(400).json({ error: "contact_phone is invalid" });
      return;
    }

    const result = await syncHistory({ vendedorId, contactPhone, limit });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error({ error }, "history/sync failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  }
});

const retentionCleanupTimer = startRetentionCleanup();

const server = app.listen(port, async () => {
  await fs.mkdir(path.resolve(sessionRoot), { recursive: true });
  logger.info({ port, sessionRoot }, "whatsapp-baileys-service started");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down whatsapp-baileys-service");
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
