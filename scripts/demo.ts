// One-command demo of AGI Command.
//
//   npm run demo
//
// Turns the feature on, binds to every interface so a phone on the same Wi-Fi
// can reach it, and prints the exact URLs and commands to pair a device. The
// gateway runs in-process, so this is the only process you need.
//
// Nothing here is required in production — it is a convenience wrapper that
// sets environment variables and then starts the ordinary server.

import os from 'node:os';

// Must be set before ./src/config.js is first imported.
process.env.AGI_COMMAND_ENABLED = 'true';
// Empty means the gateway runs inside this process on this port.
process.env.DEVICE_GATEWAY_URL = '';
process.env.HOST ??= '0.0.0.0';
process.env.PORT ??= '3000';
process.env.LOG_LEVEL ??= 'info';

/** First non-internal IPv4 address, so a phone can reach this machine. */
function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const { startServer } = await import('../src/http/server.js');
  await startServer();

  const port = process.env.PORT;
  const lan = lanAddress();
  const base = lan ? `http://${lan}:${port}` : `http://localhost:${port}`;

  const lines = [
    '',
    '  AGI Command demo is running.',
    '',
    `    This machine   http://localhost:${port}`,
  ];
  if (lan) {
    lines.push(`    Same Wi-Fi     ${base}   <- open this on your phone`);
  } else {
    lines.push('    No LAN address found, so other devices cannot reach this machine.');
  }
  lines.push(
    '',
    '  To demo without installing anything:',
    '    1. Open the URL on your laptop, sign in, then Devices -> "Use this browser as a device".',
    '    2. Open the same URL on your phone, sign in as the SAME user, do the same.',
    '    3. Ask: "how many devices are connected?" then "open youtube on this browser".',
    '',
    '  To demo simulated hardware (separate terminal, no phone needed):',
    '    Devices -> "Pair a device", copy the code, then:',
    '',
    `      npm run simulate-device -- --name "Phone One" --type android_phone \\`,
    `        --app http://localhost:${port} --gateway ws://localhost:${port}/agent --code ABCD-EFGH`,
    '',
    '    Repeat with a second name to show concurrent dispatch and partial failure:',
    '      add --fail app.open to make one device refuse, then ask to open something',
    '      on all your phones and watch it report exactly which one failed.',
    '',
  );
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
