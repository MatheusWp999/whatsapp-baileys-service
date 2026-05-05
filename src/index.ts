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
  reconnectTimer: NodeJS.Timeout | null;
}

interface HistorySyncInput {
  vendedorId: string;
  contactPhone: string;
  limit: number;
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const port = Number(process.env.PORT || 3000);
const sessionRoot = process.env.BAILEYS_SESSION_DIR || "/data/sessions";
const apiToken = (process.env.API_TOKEN || "").trim();

const sessions = new Map<string, SessionState>();

let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;

  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !key) return null;

  supabaseAdmin = createClient(url, key);
  return supabaseAdmin;
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
    reconnectTimer: null,
  };

  sessions.set(vendedorId, created);
  return created;
}

function sessionStatusPayload(state: SessionState) {
  return {
    vendedor_id: state.vendedorId,
    status: state.status,
    connected: state.status === "connected",
    qr_raw: state.qrRaw,
    last_error: state.lastError,
  };
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
        webhook_configured: false,
        webhook_last_error: state.lastError,
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

  const { data } = await supabase
    .from("whatsapp_card_active_links")
    .select("card_id, contact_phone")
    .eq("vendedor_id", vendedorId)
    .eq("active", true);

  const normalized = normalizePhone(phone);
  for (const row of data || []) {
    const linked = normalizePhone(row.contact_phone || "");
    if (!linked) continue;
    if (linked.endsWith(normalized) || normalized.endsWith(linked)) {
      return row.card_id || null;
    }
  }

  return null;
}

async function storeMessage(vendedorId: string, item: proto.IWebMessageInfo) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const key = item.key;
  const remoteJid = key?.remoteJid || "";
  const contactPhone = normalizePhone((remoteJid.split("@")[0] || remoteJid || "").trim());
  if (!contactPhone) return;

  const content = extractMessageText(item.message) || "[media]";
  const direction = key?.fromMe ? "out" : "in";
  const externalId = textValue(key?.id);
  const createdAt = messageTimestampToIso(item.messageTimestamp) || new Date().toISOString();
  const messageType = content === "[media]" ? "media" : "text";
  const cardId = await resolveCardIdForPhone(vendedorId, contactPhone);

  const payload = {
    vendedor_id: vendedorId,
    card_id: cardId,
    contact_phone: contactPhone,
    contact_phone_last8: normalizePhoneLast8(contactPhone),
    contact_name: "",
    direction,
    content,
    message_type: messageType,
    external_id: externalId || null,
    created_at: createdAt,
  };

  if (externalId) {
    await supabase.from("whatsapp_messages").upsert(payload, { onConflict: "vendedor_id,external_id" });
  } else {
    await supabase.from("whatsapp_messages").insert(payload);
  }
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
  const state = ensureSessionState(vendedorId);

  if (state.initializing) return state;
  if (state.sock && !forceRestart) return state;

  state.initializing = true;

  if (forceRestart && state.sock) {
    try {
      await state.sock.logout();
    } catch {
      // ignore
    }
    state.sock = null;
    state.status = "disconnected";
    state.qrRaw = null;
  }

  try {
    const sessionDir = path.join(sessionRoot, vendedorId);
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

        state.status = "disconnected";
        state.lastError = code ? `Disconnected (${code})` : "Disconnected";
        state.sock = null;
        await updateConnectionRow(state);

        if (!loggedOut) {
          await scheduleReconnect(vendedorId);
        }
      }
    });

    sock.ev.on("messages.upsert", async (payload) => {
      try {
        for (const message of payload.messages || []) {
          if (!message?.message) continue;
          await storeMessage(vendedorId, message);
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

async function disconnectSession(vendedorId: string) {
  const state = ensureSessionState(vendedorId);
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  try {
    if (state.sock) {
      await state.sock.logout();
    }
  } catch {
    // ignore
  }

  state.sock = null;
  state.status = "disconnected";
  state.qrRaw = null;
  state.lastError = null;
  await updateConnectionRow(state);
  return state;
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
    await storeMessage(input.vendedorId, msg);
    synced += 1;
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
  const vendedorId = textValue(req.query.vendedor_id) || textValue(req.body?.vendedor_id);
  if (!vendedorId) {
    res.status(400).json({ error: "vendedor_id is required" });
    return null;
  }
  return vendedorId;
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-baileys-service", ts: new Date().toISOString() });
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

    const state = await startSession(vendedorId, true);
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
      const cardId = textValue(req.body?.card_id) || null;
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

      if (externalId) {
        await supabase.from("whatsapp_messages").upsert(payload, { onConflict: "vendedor_id,external_id" });
      } else {
        await supabase.from("whatsapp_messages").insert(payload);
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

app.listen(port, async () => {
  await fs.mkdir(path.resolve(sessionRoot), { recursive: true });
  logger.info({ port, sessionRoot }, "whatsapp-baileys-service started");
});
