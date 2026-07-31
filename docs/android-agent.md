# Android agent

Kotlin. Source: [`agents/android/`](../agents/android)

> **Status: compiled in CI, never run on a device.**
>
> The `android agent` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
> runs `gradle assembleDebug` on every push and pull request, so this module is
> genuinely compiled — a syntax error, a bad API call or a broken manifest fails
> CI. It is *not* covered by `npm run build`.
>
> What is still unverified: **runtime behaviour**. Nobody has installed this on a
> phone, paired it, or watched it reconnect. The wire protocol it speaks is
> covered by tests through the TypeScript agents, so the frame format is
> known-good; the Android-specific behaviour is not. Work through the checklist
> at the end of this document before trusting it.

---

## Building

```bash
cd agents/android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

Requires Android Studio or the command-line SDK, JDK 17, `minSdk` 26.

---

## Pairing

1. In AGI-v1: **Devices → Pair a device**.
2. In the app: set the AGI-v1 URL and gateway URL, enter the code, tap **Pair
   this device**.
3. Tap **Start agent**.

On an emulator, the host machine is `10.0.2.2`:

```
AGI-v1 URL:  http://10.0.2.2:3000
Gateway URL: ws://10.0.2.2:3100/agent
```

Use `https://` and `wss://` anywhere real.

---

## Capabilities

```
device.ping · device.status · battery.read
app.open · url.open
media.play · media.pause · media.next · media.previous
volume.get · volume.set · volume.mute · volume.unmute
screen.wake · notification.show
```

All implemented with ordinary, documented Android APIs:

| Capability | API |
|---|---|
| `app.open` | `PackageManager.getLaunchIntentForPackage` against a fixed allowlist |
| `url.open` | `Intent.ACTION_VIEW`, http/https only |
| `media.*` | `AudioManager.dispatchMediaKeyEvent` — reports `rejected` when nothing is playing |
| `volume.*` | `AudioManager` on `STREAM_MUSIC`, absolute percentages |
| `battery.read` | `BatteryManager` |
| `screen.wake` | A short `SCREEN_BRIGHT_WAKE_LOCK`. Turns the screen on; **does not unlock** — the keyguard is untouched and the result explicitly reports `stillLocked: true` |
| `notification.show` | `NotificationCompat` on its own channel |

### App allowlist

`youtube`, `gmail`, `maps`, `calendar`, `drive`, `chrome`, `spotify`,
`whatsapp`, `keep`, `clock`, `settings`.

Declared twice, on purpose: in `Capabilities.APP_ALLOWLIST` and in the manifest's
`<queries>`. Anything not listed is invisible to the app and cannot be launched.
Edit both to add one.

---

## What this agent will not do

- **No unlocking, and no PIN/pattern/biometric bypass.** No app-level API exists
  for this, and the agent does not attempt a workaround.
- **No Accessibility Service.** An accessibility service can read and act on
  every screen. Using it as a general remote-control channel would make the agent
  far more dangerous than the actions it exposes, so it is not used at all.
- **No ADB dependency.** A clearly-labelled development-only ADB adapter would be
  acceptable; the proper agent does not rely on one, and none is shipped.
- **No microphone, camera or screen capture.** The permissions are not requested
  and the code does not exist.
- **No `QUERY_ALL_PACKAGES`.** The `<queries>` allowlist is used instead.

Permissions requested: `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `WAKE_LOCK`.

---

## Credential storage

`EncryptedSharedPreferences` with a `MasterKey` in the Android Keystore:
encrypted at rest, unreadable to other apps, never logged, never placed in an
Intent extra.

**Unpair** clears it locally. Revoke the device in AGI-v1 as well — that is the
authoritative half.

---

## Foreground service

The connection lives in a foreground service with a permanent notification. That
is the honest way to hold a long-lived socket on modern Android: the user can
always see the agent is running and stop it. A background service would be killed
by the OS, and pretending otherwise would make AGI-v1 report devices as online
when they are not reachable.

The service is `START_STICKY` and not exported — nothing outside the app can
start or stop it.

---

## Structure

| File | Role |
|---|---|
| `Protocol.kt` | Wire format, mirrored by hand from [device-protocol.md](./device-protocol.md) |
| `CredentialStore.kt` | Keystore-backed credential storage |
| `Capabilities.kt` | The capability implementations and the app allowlist |
| `AgentClient.kt` | OkHttp WebSocket, reconnect with jitter, heartbeats, replay refusal |
| `AgentService.kt` | Foreground service |
| `MainActivity.kt` | Pairing, status, recent commands, unpair |

---

## Before trusting it

CI proves it compiles. It does not prove it works. Check at minimum:

- [ ] Pairing succeeds and the credential survives a restart
- [ ] It reconnects after aeroplane mode on/off
- [ ] A revoked device stops reconnecting instead of looping
- [ ] Battery drain over a few hours is acceptable
- [ ] Doze mode behaviour matches your expectations
- [ ] Each capability does what its name says on your device
- [ ] `screen.wake` really does leave the device locked

---

## Troubleshooting

**Will not connect from an emulator** — use `10.0.2.2`, not `localhost`.

**Cleartext blocked** — Android blocks plain HTTP by default. Use `https`/`wss`,
or add a debug-only network security config.

**Disconnects when backgrounded** — check battery optimisation for the app.

**Media keys do nothing** — the agent reports `rejected` when
`AudioManager.isMusicActive` is false. Start playback first.
