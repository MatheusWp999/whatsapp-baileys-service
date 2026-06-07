# WhatsApp Baileys Service

Service to run WhatsApp sessions with Baileys for CRM integrations.

## Features

- Multi-session by `vendedor_id`
- QR generation and connection status
- Send outbound messages
- Inbound message capture with Supabase persistence only for active card links
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

Messages are persisted in `whatsapp_messages` only when the phone has an active row in `whatsapp_card_active_links` for the same `vendedor_id`. Unlinked inbound/history messages are ignored by persistence.

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
