import { config } from './config.js';
import { logger } from './logger.js';
import { startServer } from './http/server.js';

async function main(): Promise<void> {
  logger.info(
    { port: config.port, dataDir: config.dataDir, llmBackend: config.llmBackend },
    'AGI-v1 booting',
  );
  await startServer();
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal boot error');
  process.exit(1);
});
