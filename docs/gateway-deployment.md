# Gateway deployment

The device gateway is a small long-running process that owns the WebSocket
connections to your device agents. It exists because persistent connections need
a process that stays alive, and a serverless request handler does not.

```
AGI-v1 web application  (serverless or long-running)
            │  authenticated internal HTTP, both directions
            ▼
Device gateway          (must be long-running)
            │  secure WebSocket
            ▼
Connected device agents
```

The gateway holds **no database**. It authenticates a device by asking the app,
relays validated frames, and reports what it saw.

---

## Local development

Two terminals.

```bash
npm run dev
```

```bash
npm run gateway
```

`.env` needs:

```dotenv
AGI_COMMAND_ENABLED=true
DEVICE_GATEWAY_URL=http://127.0.0.1:3100
DEVICE_GATEWAY_INTERNAL_SECRET=<32+ characters>
DEVICE_GATEWAY_PORT=3100
DEVICE_GATEWAY_APP_URL=http://127.0.0.1:3000
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then start some devices:

```bash
npm run simulate-device -- --name "Phone One" --type android_phone --code ABCD-EFGH
```

If the app starts with `AGI_COMMAND_ENABLED=true` and no internal secret, it
refuses to boot and tells you exactly what to set. That is deliberate: a device
control plane with no shared secret is worse than one that is switched off.

---

## Production

Build once; run two processes from the same image.

```bash
npm run build
npm start          # app        → dist/src/index.js
npm run gateway:start   # gateway → dist/src/gateway/index.js
```

### Environment

**App**

```dotenv
AGI_COMMAND_ENABLED=true
DEVICE_GATEWAY_URL=https://gateway.internal.example.com
DEVICE_GATEWAY_INTERNAL_SECRET=<shared, 32+ chars>
```

**Gateway**

```dotenv
DEVICE_GATEWAY_PORT=3100
DEVICE_GATEWAY_HOST=0.0.0.0
DEVICE_GATEWAY_INTERNAL_SECRET=<the same value>
DEVICE_GATEWAY_APP_URL=https://your-agi-v1.example.com
DEVICE_HEARTBEAT_INTERVAL_MS=15000
DEVICE_OFFLINE_AFTER_MS=45000
```

The gateway reads its own environment and never imports the app's config — it
needs no `JWT_SECRET`, no database path and no model settings.

### Networking

- Agents reach the gateway over `wss://`. Terminate TLS at the gateway or at a
  proxy in front of it.
- The app reaches the gateway over the internal API. Keep that on a private
  network where you can; it is authenticated either way.
- The gateway reaches the app over HTTPS.
- Proxies must not buffer or time out WebSocket upgrades. For nginx:

```nginx
location /agent {
    proxy_pass http://gateway:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

### Health

```bash
curl https://your-app/healthz/agi-command
curl -H "x-agi-gateway-secret: $SECRET" https://gateway/internal/health
```

The app reports healthy even when the gateway is down — device control shows as
unavailable rather than taking chat with it.

---

## Docker

The existing `Dockerfile` builds the app image. The gateway runs from the same
image with a different command:

```yaml
services:
  app:
    build: .
    environment:
      AGI_COMMAND_ENABLED: "true"
      DEVICE_GATEWAY_URL: http://gateway:3100
      DEVICE_GATEWAY_INTERNAL_SECRET: ${DEVICE_GATEWAY_INTERNAL_SECRET}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
    ports: ["7860:7860"]

  gateway:
    build: .
    command: ["node", "dist/src/gateway/index.js"]
    environment:
      DEVICE_GATEWAY_HOST: 0.0.0.0
      DEVICE_GATEWAY_PORT: "3100"
      DEVICE_GATEWAY_APP_URL: http://app:7860
      DEVICE_GATEWAY_INTERNAL_SECRET: ${DEVICE_GATEWAY_INTERNAL_SECRET}
    ports: ["3100:3100"]
```

---

## Hugging Face Spaces

The current deployment target exposes **one** port, so a Space can host the app
but not a second long-running gateway process. Options:

1. **Leave device control off in the Space** (`AGI_COMMAND_ENABLED=false`, the
   default). Everything else works exactly as before, and the UI says device
   control is unavailable.
2. **Run the gateway elsewhere** — a small VPS, Fly.io, Railway — and point
   `DEVICE_GATEWAY_URL` at it.

Option 1 is the honest default and is what a fresh clone does.

---

## Scaling notes

- The gateway is stateful in the only way that matters: it holds the sockets.
  Running two instances means a device is connected to exactly one of them, so
  dispatch must reach that one. Until there is a shared connection registry, run
  a single gateway instance.
- The app's SSE notifications are in-process. Multiple app instances would need a
  shared broker for live UI updates. Durable command state is already shared via
  the database, so a browser on another instance still converges on the right
  answer — it just updates on reload rather than instantly.

---

## What runs where

| Concern | App | Gateway |
|---|---|---|
| Database | ✅ | ❌ |
| Policy and confirmation | ✅ | ❌ |
| Target resolution | ✅ | ❌ |
| User sessions | ✅ | ❌ |
| WebSocket connections | ❌ | ✅ |
| Frame validation | ✅ (results) | ✅ (inbound) |
| Heartbeat tracking | ✅ (last seen) | ✅ (liveness) |
