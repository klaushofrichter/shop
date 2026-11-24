/**
 * The release version, `YYYY.MM.DD.N`, stamped into the image at deploy time
 * (Dockerfile `ARG APP_VERSION`). A local or `main` build reports `dev` or
 * `main`, which is a useful tell. Never stored in the source (ADR-0016).
 */
export function appVersion(): string {
  return process.env.APP_VERSION || 'dev';
}
