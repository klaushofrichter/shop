import { createApp } from './app';
import { appVersion } from './version';

const port = Number(process.env.PORT) || 8080;

createApp().listen(port, () => {
  console.log(`shop ${appVersion()} listening on port ${port}`);
});
