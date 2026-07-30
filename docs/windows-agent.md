# Windows agent

TypeScript and Node, sharing protocol types with the server so a protocol change
is a compile error rather than a runtime mystery.

Source: [`agents/windows/`](../agents/windows)

---

## Running it

```bash
npm run agent:windows -- --code ABCD-EFGH   # first run: pairs
npm run agent:windows                       # afterwards
npm run agent:windows -- --unpair           # forget the credential
npm run agent:windows -- --help
```

| Option | Default |
|---|---|
| `--name` | the computer's hostname |
| `--app` | `http://127.0.0.1:3000` |
| `--gateway` | `ws://127.0.0.1:3100/agent` |

The credential is stored at `~/.agi-command/<name>.json` with mode `0600`.

---

## What it advertises

```
device.ping · device.status · battery.read
app.open · url.open · notification.show
media.next · media.previous
```

## What it deliberately does not advertise, and why

This is the part worth reading. The capability registry permits these on Windows;
this agent declines to claim them because it cannot do them correctly without
native modules or guesswork.

| Capability | Why not |
|---|---|
| `media.play`, `media.pause` | Windows exposes a single `PLAY_PAUSE` **toggle** key. Implementing "play" with it would sometimes pause instead. Claiming the capability would make the assistant lie. |
| `volume.get`, `volume.set` | There is no dependency-free way to read or set an absolute level. Only relative up/down keys exist. |
| `volume.mute`, `volume.unmute` | The mute key is a toggle with no readback, so "unmute" could mute. |
| `screen.wake` | Waking a locked Windows session is an OS-guarded action. |

A capability that is not advertised is reported to the user as *"this device does
not report support for it"* — which is true. That is better than a capability
that silently misbehaves, and it is why the resolver has an `unsupported`
category at all.

If you want these, the honest route is a native helper (for example the Core
Audio API via a small addon) and then advertising them for real.

---

## The app allowlist

The server only ever sends a symbolic id such as `youtube`. Nothing in the
protocol can carry a path, a command or arguments.

Built in: `youtube`, `gmail`, `github`, `calendar`, `drive`, `maps`, `notion`,
`spotify`, `settings`, `calculator`, `notepad`, `vscode`, `chrome`, `firefox`.

Add your own in `~/.agi-command/windows-apps.json`:

```json
{
  "obsidian": {
    "kind": "exe",
    "candidates": ["C:\\Users\\me\\AppData\\Local\\Obsidian\\Obsidian.exe"]
  },
  "fixmap": { "kind": "url", "target": "https://github.com/you/fixmap" },
  "slack": { "kind": "protocol", "target": "slack:" }
}
```

Entries are validated on load:

- `url` must be `http(s)`.
- `protocol` must look like a scheme.
- `exe` must be an absolute path ending in `.exe`, with no shell metacharacters.

An unknown id is refused with a message naming the file, not guessed at.

This file is on your own machine, written by you. It is not reachable from the
network or from a model.

---

## How actions are performed

Everything goes through `spawn()` with `shell: false`. Dynamic values are passed
as **environment variables**, never interpolated into a command string, so there
is no place for injection to happen.

| Action | Mechanism |
|---|---|
| `url.open`, protocol apps | `rundll32.exe url.dll,FileProtocolHandler <target>` — the target is a single argv entry, so unlike `cmd /c start` there is no shell to escape from |
| Executable apps | `spawn(absolutePath, [])` — no arguments, ever |
| `battery.read` | PowerShell `Get-CimInstance Win32_Battery`; a desktop with no battery reports `unsupported`, not a fake number |
| `notification.show` | A fixed WinForms balloon script; title and body arrive via `AGI_NOTIF_TITLE` / `AGI_NOTIF_BODY` |
| `media.next`, `media.previous` | `keybd_event` from `user32.dll` with `VK_MEDIA_NEXT_TRACK` / `VK_MEDIA_PREV_TRACK`, both unambiguous |

The PowerShell snippets are fixed and vendored in the source. The agent does not
accept PowerShell, CMD, JavaScript, or model-generated code from anywhere.

---

## Requirements

- Windows 10 or 11
- Node.js 20+
- Windows PowerShell (built in)

The agent refuses to run on a non-Windows platform and points you at
`npm run simulate-device` instead.

---

## Running it as a service

The agent is a plain Node process. To keep it running after logout, wrap it with
a service manager such as [NSSM](https://nssm.cc/):

```
nssm install AgiCommandAgent "C:\Program Files\nodejs\node.exe" "C:\path\to\AGI-v1\node_modules\tsx\dist\cli.mjs" "C:\path\to\AGI-v1\agents\windows\index.ts"
```

Run it as the interactive user. Under a service account it would have no desktop
session to launch applications into.

---

## Troubleshooting

**"is not in this computer's app allowlist"** — add it to
`~/.agi-command/windows-apps.json`.

**"allowlisted but not installed"** — none of the candidate paths exist. Check
the actual install location and add it.

**Notifications do not appear** — check Windows Focus Assist and notification
settings. The balloon is a normal notification and obeys them.

**Media keys do nothing** — they go to whichever app holds audio focus. If
nothing is playing, there is nothing to control.

**The agent will not connect** — see [troubleshooting.md](./troubleshooting.md).
