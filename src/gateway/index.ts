// Entry point for the standalone device gateway.
//
//   npm run gateway          (dev, via tsx)
//   node dist/src/gateway/index.js   (built)

import { loadGatewayConfig } from './config.js';
import { createGatewayServer } from './server.js';

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const gateway = createGatewayServer(config);
  await gateway.listen();

  const shutdown = async (signal: string) => {
    gateway.app.log.info({ signal }, 'shutting down device gateway');
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Config errors are the common case here and are written to be actionable.
  // eslint-disable-next-line no-console
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
