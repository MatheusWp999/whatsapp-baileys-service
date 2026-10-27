# WhatsApp Baileys Service

Service to run WhatsApp sessions with Baileys for CRM integrations.

## Features

- Multi-session by `vendedor_id`
- QR generation and connection status
- Send outbound messages
- Inbound message capture for CRM visibility
- Automatic chat and message history from Baileys `messaging-history.set`
- Durable conversation projection in `whatsapp_chats`
- Session reset/logout with auth-state cleanup for stale QR sessions

## Endpoints

- `GET /health`
- `GET /session/status?vendedor_id=<uuid>`
- `POST /session/refresh-qr`
- `POST /session/disconnect`
- `POST /session/reset`
- `POST /session/logout`
- `POST /message/send`
- `POST /chat/read`
- `POST /history/sync`

All endpoints except `/health` require `API_TOKEN` authentication.

Header options:

- `Authorization: Bearer <API_TOKEN>`
- `x-api-key: <API_TOKEN>`
- `x-vendedor-id: <vendedor_id>`
- `x-instance-name: <instance_name>` (optional, must match the service-generated instance name)

Chats and direct inbound/outbound messages are written to `whatsapp_chats` and `whatsapp_messages`. Initial history is persisted when Baileys emits `messaging-history.set`. When a phone matches exactly one card for the same `vendedor_id`, live messages can be linked automatically to the card.

Retention is enforced by the service:

- Linked messages (`card_id IS NOT NULL`) are kept for `WHATSAPP_LINKED_RETENTION_DAYS` days, default `90`.
- Unlinked messages (`card_id IS NULL`) are kept for `WHATSAPP_UNLINKED_RETENTION_DAYS` days, default `90`.
- Empty chat projections older than the longest configured retention period are removed.
- Stored media follows the message retention policy and remains private in `whatsapp-media`.

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
- `API_TOKEN` (required)
- `BAILEYS_SESSION_DIR` (default `/data/sessions`)
- `BAILEYS_INSTANCE_PREFIX` (default `crm-`)
- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required)
- `WHATSAPP_LINKED_RETENTION_DAYS` (default `90`)
- `WHATSAPP_UNLINKED_RETENTION_DAYS` (default `90`)
- `WHATSAPP_MEDIA_MAX_BYTES` (default `15000000`)

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
6. Configure `API_TOKEN`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
