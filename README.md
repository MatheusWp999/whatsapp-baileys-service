# WhatsApp Baileys Service

Service to run WhatsApp sessions with Baileys for CRM integrations.

## Features

- Multi-session by `vendedor_id`
- QR generation and connection status
- Send outbound messages
- Inbound message capture for CRM visibility
- History sync endpoint (`/history/sync`) using WA Web fetch
- Session reset/logout with auth-state cleanup for stale QR sessions

## Endpoints

- `GET /health`
- `GET /session/status?vendedor_id=<uuid>`
- `POST /session/refresh-qr`
- `POST /session/disconnect`
- `POST /session/reset`
- `POST /session/logout`
- `POST /message/send`
- `POST /history/sync`

All endpoints except `/health` require auth when `API_TOKEN` is configured.

Header options:

- `Authorization: Bearer <API_TOKEN>`
- `x-api-key: <API_TOKEN>`
- `x-vendedor-id: <vendedor_id>`
- `x-instance-name: <instance_name>` (optional, must match the service-generated instance name)

All direct inbound/outbound messages are written to `whatsapp_messages` so they can appear in the CRM while the session is connected. When a phone matches exactly one card for the same `vendedor_id`, the service auto-creates an active link in `whatsapp_card_active_links` and saves the message with `card_id`.

Retention is enforced by the service:

- Linked messages (`card_id IS NOT NULL`) are kept for `WHATSAPP_LINKED_RETENTION_DAYS` days, default `90`.
- Unlinked messages (`card_id IS NULL`) are temporary and kept for `WHATSAPP_UNLINKED_RETENTION_HOURS` hours, default `24`, so they can appear in the CRM and be linked to a card.

## Request examples

### Refresh QR

```bash
curl -X POST "http://localhost:3000/session/refresh-qr" \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"vendedor_id":"00000000-0000-0000-0000-000000000000"}'
```

### Send message

```bash
curl -X POST "http://localhost:3000/message/send" \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "vendedor_id":"00000000-0000-0000-0000-000000000000",
    "phone":"5511999998888",
    "text":"Hello from Baileys"
  }'
```

## Environment variables

Copy `.env.example` to `.env` and set values.

- `PORT` (default `3000`)
- `NODE_ENV` (recommended `production`)
- `LOG_LEVEL` (default `info`)
- `API_TOKEN` (recommended)
- `BAILEYS_SESSION_DIR` (default `/data/sessions`)
- `BAILEYS_INSTANCE_PREFIX` (default `crm-`)
- `SUPABASE_URL` (optional)
- `SUPABASE_SERVICE_ROLE_KEY` (optional)
- `WHATSAPP_LINKED_RETENTION_DAYS` (default `90`)
- `WHATSAPP_UNLINKED_RETENTION_HOURS` (default `24`)

## Run locally

```bash
npm install
npm run dev
```

## Build and run

```bash
npm run build
npm run start
```

## Coolify notes

1. Use Node 20+
2. Add persistent storage mounted to `/data`
3. Set env vars in Coolify
4. Use `/health` as healthcheck
5. Keep exactly one replica unless session storage and websocket ownership are redesigned
6. Configure `API_TOKEN`; without it, private endpoints are intentionally open for local development
