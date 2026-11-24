import { CatalogConfigError } from './catalog-config';
import { ConfigError } from './config';
import { StartupRefused } from './providers/checks';
import { startShop, type Shop } from './startup';
import { appVersion } from './version';

async function main(): Promise<void> {
  let shop: Shop;
  try {
    shop = startShop();
    await shop.ready();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof CatalogConfigError || e instanceof StartupRefused) {
      console.error(JSON.stringify({ level: 'fatal', msg: 'start refused', problems: e.message }));
      process.exit(1);
    }
    throw e;
  }

  shop.runner.start();
  const server = shop.app.listen(shop.config.port, () => {
    console.log(`shop ${appVersion()} (${shop.config.mode}) listening on port ${shop.config.port}`);
  });

  // Recreate deployments stop the old pod first: finish cleanly.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      shop.runner.stop();
      server.close(() => {
        shop.dbs.close();
        process.exit(0);
      });
    });
  }
}

void main();
