# Gateway deployment

The device gateway owns the WebSocket connections to your device agents. It can
run two ways, and the same connection code (`src/gateway/hub.ts`) backs both.

## Embedded — the default

If `DEVICE_GATEWAY_URL` is empty, the gateway runs **inside the app process**, on
the app's own port. Agents connect to `wss://<your-app>/agent`.

```
AGI-v1 (one long-running process)
  ├── HTTP + SSE for browsers
  └── /agent  WebSocket for device agents
            │
            ▼
    Connected device agents
```

This is right for anything that runs one long-lived container — Docker, Fly,
Railway, Hugging Face Spaces — and for local development. There is no second
process, no extra port, and **no shared secret to configure**, because there is
no network hop between the app and the hub.

## Standalone — for a serverless web tier

If `DEVICE_GATEWAY_URL` is set, the app talks to a separate gateway process over
an authenticated internal HTTP API. This is what you need when the web tier
cannot hold a socket open, as on Vercel.

```
AGI-v1 web application  (serverless)
            │  authenticated internal HTTP, both directions
            ▼
Device gateway          (must be long-running)
            │  secure WebSocket
            ▼
Connected device agents
```

The gateway holds **no database** in either mode. It authenticates a device by
asking the app, relays validated frames, and reports what it saw.

---

## Local development

One terminal:

```bash
npm run dev
```

`.env` needs only:

```dotenv
AGI_COMMAND_ENABLED=true
```

Then start some devices — note the gateway is on the app's port:

```bash
npm run simulate-device -- --name "Phone One" --type android_phone \
  --gateway ws://127.0.0.1:3000/agent --code ABCD-EFGH
```

### Running the standalone gateway locally instead

Two terminals, and a shared secret:

```bash
npm run dev
```

```bash
npm run gateway
```

```dotenv
AGI_COMMAND_ENABLED=true
DEVICE_GATEWAY_URL=http://127.0.0.1:3100
DEVICE_GATEWAY_INTERNAL_SECRET=<32+ characters>
DEVICE_GATEWAY_PORT=3100
DEVICE_GATEWAY_APP_URL=http://127.0.0.1:3000
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If `DEVICE_GATEWAY_URL` is set without a secret, the app refuses to boot and
tells you what to set. That is deliberate: a device control plane with an
unauthenticated app↔gateway channel is worse than one that is switched off.

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

A Space exposes one port and runs one long-lived container, which is exactly what
embedded mode is for. The `Dockerfile` sets `AGI_COMMAND_ENABLED=true` and leaves
`DEVICE_GATEWAY_URL` empty, so the gateway runs in-process and agents connect to:

```
wss://<user>-<space>.hf.space/agent
```

Set `GEMINI_API_KEY` and `JWT_SECRET` as Space secrets. Nothing else is needed —
in particular there is no `DEVICE_GATEWAY_INTERNAL_SECRET`, because there is no
app↔gateway network hop to authenticate.

Storage is the container's local SQLite file. Space storage is ephemeral across
rebuilds unless you attach persistent storage, so paired devices are lost when
the Space restarts and have to be paired again.

## Vercel

Vercel functions cannot hold a WebSocket open and have no persistent disk, so
**device control does not run there**. The app reports it as unavailable and
ordinary chat is unaffected. To use devices with a Vercel front end you would
need to run a standalone gateway elsewhere *and* implement the device
repositories for Postgres, which are currently SQLite-only.

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
