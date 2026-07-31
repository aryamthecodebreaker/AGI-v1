// The Windows device agent.
//
//   npm run agent:windows -- --code ABCD-EFGH        (first run, pairs)
//   npm run agent:windows                            (afterwards)
//
// What this agent advertises is deliberately narrower than what the capability
// registry allows on Windows. It only claims what it can do correctly with no
// native modules and no guessing:
//
//   advertised: device.ping, device.status, battery.read, app.open, url.open,
//               notification.show, media.next, media.previous
//
//   NOT advertised, and why:
//     media.play / media.pause — Windows exposes one PLAY_PAUSE toggle key, so
//       "play" would sometimes pause. Claiming it would make the assistant lie.
//     volume.get / volume.set  — there is no dependency-free way to read or set
//       an absolute level; only relative up/down/mute keys exist.
//     volume.mute / volume.unmute — the mute key is a toggle with no readback,
//       so "unmute" could mute.
//     screen.wake — waking a locked Windows session is an OS-guarded action.
//
// A capability that is not advertised is reported to the user as "this device
// does not report support for it", which is true, rather than silently failing.
//
// Everything that touches the OS goes through spawn() with shell: false. Dynamic
// values are passed as environment variables, never interpolated into a command
// string, so there is no place for injection to happen.

import { spawn } from 'node:child_process';
import os from 'node:os';
import {
  RejectedByDevice,
  UnsupportedOnThisDevice,
  createAgent,
  type CapabilityHandler,
} from '../shared/agent.js';
import { loadAllowlist, resolveExecutable, userAllowlistPath } from './appAllowlist.js';

const AGENT_VERSION = 'windows-1.0.0';

/** Run a fixed PowerShell snippet. No caller-controlled text is ever inlined. */
function runPowerShell(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the command timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exited with code ${code}`));
    });
  });
}

/**
 * Open a URL or protocol with the registered default handler.
 * rundll32 + FileProtocolHandler takes the target as a single argv entry, so
 * unlike `cmd /c start` there is no shell to escape from.
 */
function openWithShellHandler(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.unref();
    // rundll32 hands off and exits; a successful spawn is the signal.
    resolve();
  });
}

function launchExecutable(absolutePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // No arguments, ever. The allowlist decided the path; nothing else can.
    const child = spawn(absolutePath, [], {
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

/** Reads battery via CIM. A desktop with no battery says so rather than lying. */
const BATTERY_SCRIPT = `
$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $b) { Write-Output "none" }
else {
  $charging = if ($b.BatteryStatus -eq 2) { "true" } else { "false" }
  Write-Output ("{0}|{1}" -f $b.EstimatedChargeRemaining, $charging)
}`.trim();

/**
 * Media keys via the documented user32 keybd_event API. Only NEXT and PREVIOUS
 * are used: they are unambiguous, unlike the play/pause toggle.
 */
const MEDIA_KEY_SCRIPT = `
$code = [byte]$env:AGI_MEDIA_VK
Add-Type -Namespace AgiCommand -Name Keys -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
[AgiCommand.Keys]::keybd_event($code, 0, 0, [System.UIntPtr]::Zero)
[AgiCommand.Keys]::keybd_event($code, 0, 2, [System.UIntPtr]::Zero)
Write-Output "ok"`.trim();

/** Balloon notification via WinForms, present on every supported Windows. */
const NOTIFY_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Visible = $true
$icon.ShowBalloonTip(5000, $env:AGI_NOTIF_TITLE, $env:AGI_NOTIF_BODY, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Milliseconds 5500
$icon.Dispose()
Write-Output "ok"`.trim();

const VK_MEDIA_NEXT_TRACK = 176;
const VK_MEDIA_PREV_TRACK = 177;

async function readBattery(): Promise<{ batteryPercent: number; charging: boolean } | null> {
  const output = await runPowerShell(BATTERY_SCRIPT);
  if (output === 'none' || !output) return null;
  const [percent, charging] = output.split('|');
  const value = Number(percent);
  if (!Number.isFinite(value)) return null;
  return { batteryPercent: value, charging: charging === 'true' };
}

export function buildWindowsHandlers(): Record<string, CapabilityHandler> {
  const allowlist = loadAllowlist();

  return {
    'device.ping': async () => ({ roundTripMs: 0 }),

    'device.status': async () => {
      const battery = await readBattery().catch(() => null);
      return {
        online: true,
        ...(battery ? { batteryPercent: battery.batteryPercent, charging: battery.charging } : {}),
        network: 'unknown',
      };
    },

    'battery.read': async () => {
      const battery = await readBattery();
      if (!battery) {
        // A desktop genuinely has no battery — that is not a failure to hide.
        throw new UnsupportedOnThisDevice('this computer has no battery');
      }
      return battery;
    },

    'app.open': async (parameters) => {
      const appId = String(parameters.appId ?? '').toLowerCase();
      const entry = allowlist[appId];
      if (!entry) {
        throw new RejectedByDevice(
          `"${appId}" is not in this computer's app allowlist. Add it to ${userAllowlistPath()} if you want it available.`,
        );
      }
      if (entry.kind === 'url' || entry.kind === 'protocol') {
        await openWithShellHandler(entry.target);
        return { launched: true };
      }
      const executable = resolveExecutable(entry);
      if (!executable) {
        throw new RejectedByDevice(`"${appId}" is allowlisted but not installed on this computer.`);
      }
      await launchExecutable(executable);
      return { launched: true };
    },

    'url.open': async (parameters) => {
      const url = String(parameters.url ?? '');
      // The server already validated the scheme; re-check locally so the agent
      // is safe even if it is ever pointed at a different server.
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RejectedByDevice('only http and https URLs are allowed');
      }
      await openWithShellHandler(url);
      return { opened: true };
    },

    'notification.show': async (parameters) => {
      const title = String(parameters.title ?? 'AGI-v1');
      const body = String(parameters.body ?? '');
      await runPowerShell(
        NOTIFY_SCRIPT,
        { AGI_NOTIF_TITLE: title, AGI_NOTIF_BODY: body },
        12_000,
      );
      return { shown: true };
    },

    'media.next': async () => {
      await runPowerShell(MEDIA_KEY_SCRIPT, { AGI_MEDIA_VK: String(VK_MEDIA_NEXT_TRACK) });
      return { skipped: true };
    },

    'media.previous': async () => {
      await runPowerShell(MEDIA_KEY_SCRIPT, { AGI_MEDIA_VK: String(VK_MEDIA_PREV_TRACK) });
      return { skipped: true };
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  };

  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(
      [
        'AGI Command — Windows agent',
        '',
        '  npm run agent:windows -- --code ABCD-EFGH   pair for the first time',
        '  npm run agent:windows                       run an already-paired agent',
        '  npm run agent:windows -- --unpair           forget this device credential',
        '',
        'Options:',
        '  --name <name>       device name (default: this computer\'s hostname)',
        '  --app <url>         AGI-v1 base URL (default http://127.0.0.1:3000)',
        '  --gateway <url>     gateway WS URL (default ws://127.0.0.1:3000/agent, the app port)',
        '',
        `App allowlist: ${userAllowlistPath()}`,
      ].join('\n'),
    );
    return;
  }

  if (process.platform !== 'win32') {
    // eslint-disable-next-line no-console
    console.error(
      `This agent uses Windows APIs and cannot run on ${process.platform}. ` +
        `Use "npm run simulate-device" for a cross-platform stand-in.`,
    );
    process.exit(1);
    return;
  }

  const name = arg('name') ?? os.hostname();
  const agent = createAgent({
    name,
    deviceType: 'windows',
    platform: 'windows',
    platformVersion: os.release(),
    agentVersion: AGENT_VERSION,
    appUrl: arg('app') ?? 'http://127.0.0.1:3000',
    gatewayUrl: arg('gateway') ?? 'ws://127.0.0.1:3000/agent',
    handlers: buildWindowsHandlers(),
    // eslint-disable-next-line no-console
    log: (message) => console.log(`[${name}] ${message}`),
    // eslint-disable-next-line no-console
    onStateChange: (state, detail) =>
      console.log(`[${name}] ● ${state}${detail ? ` — ${detail}` : ''}`),
    // eslint-disable-next-line no-console
    onCommand: (entry) => console.log(`[${name}] ↳ ${entry.capability} → ${entry.outcome}`),
  });

  if (argv.includes('--unpair')) {
    agent.unpair();
    // eslint-disable-next-line no-console
    console.log('Credential cleared. This device can no longer connect.');
    return;
  }

  if (!agent.isPaired) {
    const code = arg('code');
    if (!code) {
      // eslint-disable-next-line no-console
      console.error(
        'Not paired. In AGI-v1 open Devices → Pair a device, then run:\n' +
          '  npm run agent:windows -- --code ABCD-EFGH',
      );
      process.exit(1);
      return;
    }
    await agent.pair(code);
  }

  await agent.start();

  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Only run when executed directly, so buildWindowsHandlers stays importable.
if (process.argv[1] && /windows[\\/]index\.ts$|windows[\\/]index\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  });
}
