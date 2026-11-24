import { CatalogConfigError } from './catalog-config';
import { ConfigError } from './config';
import { startShop, type Shop } from './startup';
import { appVersion } from './version';

let shop: Shop;
try {
  shop = startShop();
} catch (e) {
  if (e instanceof ConfigError || e instanceof CatalogConfigError) {
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
