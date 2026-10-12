import { FixtureServer } from '../fixtures/fixtureServer.js';

/**
 * `pnpm fixture`
 *
 * Starts the fixture website on its own, for manual experimentation or for pointing a
 * running Pagefreeze instance at a page that changes on demand.
 *
 * Control endpoints:
 *   GET  /__state          current page state
 *   POST /__state          patch the state, e.g. {"price":"$99"}
 *   GET  /__reset          restore the defaults
 *   GET  /redirect-metadata  302 to http://169.254.169.254/ (for SSRF checks)
 */

const port = Number.parseInt(process.env['FIXTURE_PORT'] ?? '8090', 10);
const mutateEvery = Number.parseInt(process.env['FIXTURE_MUTATE_MS'] ?? '0', 10);

const server = new FixtureServer({ port });
const { baseUrl } = await server.start();

if (mutateEvery > 0) server.startAutoChange(mutateEvery);

process.stdout.write(
  [
    `fixture site listening on ${baseUrl}`,
    `  page:            ${baseUrl}/pricing`,
    `  state:           ${baseUrl}/__state`,
    `  mutate:          curl -X POST ${baseUrl}/__state -d '{"price":"$99"}'`,
    `  auto-mutate:     ${mutateEvery > 0 ? `every ${mutateEvery}ms` : 'off'}`,
    '',
  ].join('\n'),
);

const stop = (): void => {
  void server.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
