# Troubleshooting AGI Command

---

## The Devices panel says device control is off

`AGI_COMMAND_ENABLED` is `false` — the default, so a fresh clone behaves exactly
like AGI-v1 did before this feature. Set it to `true` in `.env`, set a gateway
secret, and restart.

```dotenv
AGI_COMMAND_ENABLED=true
DEVICE_GATEWAY_URL=http://127.0.0.1:3100
DEVICE_GATEWAY_INTERNAL_SECRET=<32+ characters>
```

---

## The app will not start

```
AGI_COMMAND_ENABLED=true but DEVICE_GATEWAY_INTERNAL_SECRET is not set.
```

Deliberate. A device control plane with no shared secret is worse than one that
is switched off. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The same value must be set for both the app and the gateway.

---

## "Gateway unreachable" in the header

The feature is on but the gateway is not answering. Ordinary chat is unaffected.

1. Is it running? `npm run gateway`
2. Does `DEVICE_GATEWAY_URL` match its host and port?
3. Do the secrets match on both sides? A mismatch shows as unreachable, and the
   gateway logs `internal request rejected: bad secret`.
4. Check directly:

```bash
curl -H "x-agi-gateway-secret: $SECRET" http://127.0.0.1:3100/internal/health
```

---

## A device paired but stays offline

Pairing and connecting are separate steps.

1. Is the agent running?
2. Is its `--gateway` URL right? Default `ws://127.0.0.1:3100/agent`. Note the
   `/agent` path — the gateway destroys upgrades to any other path.
3. Watch the agent's output. It logs every state change: `connecting`,
   `connected`, `reconnecting`, `revoked`.
4. Check the gateway logs for `device connected`.

A device is online only when the gateway holds a socket **and** it has been heard
from within `DEVICE_OFFLINE_AFTER_MS` (default 45 s). Both halves matter: it is
what stops a crashed gateway leaving devices permanently "online".

---

## "That pairing code is not valid"

Expired, already used, or mistyped. Generate a new one. The message is the same
for all three on purpose — a caller should not learn which.

Codes last `DEVICE_PAIRING_TTL_SECONDS` (default 300) and work exactly once.

---

## "Too many pairing codes requested"

Five per user per ten minutes. Wait, or use the code you already have.

---

## The assistant asks "which one did you mean?"

The reference matched more than one device. With "Phone One" and "Phone Two",
the word "phone" is genuinely ambiguous, so it asks rather than guessing.

Either name the device exactly, or use a plural group: "all my phones".

Note that only **plural** words are groups (`phones`, `computers`, `tablets`,
`browsers`, `all`). Singular words are treated as device names, for exactly this
reason.

---

## "does not report support for …"

The device never advertised that capability. Either the agent does not implement
it — see [windows-agent.md](./windows-agent.md) for the list the Windows agent
deliberately declines — or it connected with an older capability set. Restart the
agent to re-advertise.

## "… is switched off for …"

You disabled it in **Devices → capabilities**. Tick it again.

---

## A command sits at "sent" and never finishes

The device acknowledged but never reported. It will be marked `timed_out` by the
background sweep within about half of `DEVICE_COMMAND_TIMEOUT_MS`.

Check the agent's log for an exception in that capability's handler.

---

## Nothing happens when I say "open YouTube"

Work through it in order:

1. **Is it reaching the device layer at all?** The triage gate skips messages
   that look like ordinary conversation. Naming a device or a group always
   qualifies; so does an imperative opening ("open …", "mute …") when you have at
   least one device paired.
2. **Did the planner understand it?** With `LOG_LEVEL=debug` the server logs the
   plan kind and action.
3. **Did it resolve to a device?** An empty resolution produces a clarifying
   question, not silence.
4. **Was it dispatched?** Check `GET /api/device-commands` or the command strip.

---

## The microphone does not work

- **Disabled with a tooltip** — this browser has no `SpeechRecognition`. Safari
  and Firefox have historically lacked it. Type instead; nothing is lost.
- **"Microphone permission was refused"** — grant it in site settings.
- **Nothing happens on click** — speech recognition generally requires a secure
  context. Use `https://` or `localhost`.

---

## Links open on the phone but not in the browser device

Browsers block pop-ups that are not tied to a user gesture. The browser device
reports this honestly as *"the browser blocked the pop-up"* rather than claiming
success. Allow pop-ups for the site.

---

## A revoked device keeps trying to connect

It should not. On revocation the gateway sends a fatal `unauthorized` error and
the agent stops reconnecting. If yours keeps looping, it is ignoring `fatal` —
that is an agent bug worth fixing, since retrying forever against a server that
has revoked you is a battery drain.

---

## Tests fail locally

The suite needs no cloud credentials, no API key and no physical devices. If
`tests/deviceGateway.test.ts` fails, it binds real localhost ports — check
nothing is blocking ephemeral ports and no stale gateway is running.

```bash
npm test
npm run build
```

---

## Useful diagnostics

```bash
# Feature and gateway state
curl /healthz/agi-command

# Recent device events for the signed-in user
curl /api/agi-command/events -b cookies.txt

# One command, with its events
curl /api/device-commands/$ID -b cookies.txt

# Live gateway connections
curl -H "x-agi-gateway-secret: $SECRET" http://127.0.0.1:3100/internal/connections
```

`LOG_LEVEL=debug` adds plan decisions, resolution results and dispatch detail.
Credentials, pairing codes and audio are never logged at any level.

---

## Things that are not bugs

| Behaviour | Why |
|---|---|
| "I cannot unlock a locked device" | Not implemented, and never will be |
| "I cannot run arbitrary shell commands" | Not implemented, on any platform |
| Windows does not offer volume control | The agent declines to claim what it cannot do correctly — see [windows-agent.md](./windows-agent.md) |
| A wide command asks for confirmation | Four or more devices at once is treated as moderate risk |
| Queueing for later asks for confirmation | A delayed side effect you will not be watching for |
| "partially succeeded" after a cancel | One device succeeded and another was stopped. That is not plain success |
| A late result is ignored | An execution that already finished is never reopened |
