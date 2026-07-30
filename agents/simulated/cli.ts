// CLI for running simulated devices.
//
//   npm run simulate-device -- --name "Phone One" --type android_phone --code ABCD-EFGH
//   npm run simulate-device -- --name "Phone Two" --type android_phone --code IJKL-MNOP
//   npm run simulate-device -- --name "Laptop" --type windows --code QRST-UVWX
//
// After the first run the credential is stored, so later runs need no code:
//   npm run simulate-device -- --name "Phone One"
//
// Failure modes for demos and manual testing:
//   --fail app.open            report a failure for that capability
//   --unsupported volume.set   report "not supported"
//   --hang notification.show   never answer, so the server times out
//   --delay 2000               answer slowly
//   --capabilities device.ping,battery.read   advertise only these

import { createSimulatedDevice, DEFAULT_SIMULATED_CAPABILITIES } from './device.js';
import { defaultCredentialPath } from '../shared/credentialStore.js';

interface Args {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function list(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(
      [
        'Simulated AGI Command device',
        '',
        'Usage:',
        '  npm run simulate-device -- --name "Phone One" [--type android_phone] [--code ABCD-EFGH]',
        '',
        'Options:',
        '  --name <name>            device name shown in AGI-v1 (required)',
        '  --type <type>            android_phone | android_tablet | windows | browser | generic | simulated',
        '  --code <code>            pairing code; only needed the first time',
        '  --app <url>              AGI-v1 base URL (default http://127.0.0.1:3000)',
        '  --gateway <url>          gateway WS URL (default ws://127.0.0.1:3100/agent)',
        '  --capabilities <a,b,c>   advertise only these capabilities',
        '  --fail <a,b>             report failure for these',
        '  --unsupported <a,b>      report "not supported" for these',
        '  --reject <a,b>           refuse these',
        '  --hang <a,b>             never answer these (provokes a server timeout)',
        '  --delay <ms>             delay before answering',
        '  --battery <percent>      battery level to report',
        '  --unpair                 forget the stored credential and exit',
        '',
        `Known capabilities: ${DEFAULT_SIMULATED_CAPABILITIES.join(', ')}`,
      ].join('\n'),
    );
    return;
  }

  const name = typeof args.name === 'string' ? args.name : null;
  if (!name) {
    // eslint-disable-next-line no-console
    console.error('--name is required. Run with --help for usage.');
    process.exit(1);
    return;
  }

  const appUrl = typeof args.app === 'string' ? args.app : 'http://127.0.0.1:3000';
  const gatewayUrl =
    typeof args.gateway === 'string' ? args.gateway : 'ws://127.0.0.1:3100/agent';
  const deviceType = (typeof args.type === 'string' ? args.type : 'simulated') as
    | 'android_phone'
    | 'android_tablet'
    | 'windows'
    | 'browser'
    | 'generic'
    | 'simulated';

  const prefix = `[${name}]`;
  const log = (message: string) => {
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${message}`);
  };

  const device = createSimulatedDevice({
    name,
    deviceType,
    appUrl,
    gatewayUrl,
    capabilities: list(args.capabilities),
    failCapabilities: list(args.fail),
    unsupportedCapabilities: list(args.unsupported),
    rejectCapabilities: list(args.reject),
    hangCapabilities: list(args.hang),
    delayMs: args.delay ? Number(args.delay) : 0,
    batteryPercent: args.battery ? Number(args.battery) : undefined,
    log: (message) => log(message),
    onStateChange: (state, detail) => log(`● ${state}${detail ? ` — ${detail}` : ''}`),
    onCommand: (entry) =>
      log(`↳ ${entry.capability} → ${entry.outcome}${entry.detail ? ` (${entry.detail})` : ''}`),
  });

  if (args.unpair) {
    device.agent.unpair();
    log('credential cleared');
    return;
  }

  if (!device.agent.isPaired) {
    const code = typeof args.code === 'string' ? args.code : null;
    if (!code) {
      // eslint-disable-next-line no-console
      console.error(
        `${prefix} not paired yet. Create a pairing code in AGI-v1 (Devices → Pair a device) and pass it with --code.\n` +
          `${prefix} credential would be stored at ${defaultCredentialPath(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`,
      );
      process.exit(1);
      return;
    }
    try {
      await device.agent.pair(code);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`${prefix} pairing failed: ${(err as Error).message}`);
      process.exit(1);
      return;
    }
  }

  await device.agent.start();
  log(`advertising ${device.agent.capabilities.length} capabilities`);

  const shutdown = async () => {
    log('stopping');
    await device.agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
