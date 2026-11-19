// Entry point for the github-core-clone-01 forge.
//
// Lifecycle: start the forge server on a kernel-chosen ephemeral port,
// tell the trial environment which port it is on, then stay alive until
// the environment says the trial is over. The environment owns port 8080,
// so this process never binds it.
//
// Run with: node --experimental-strip-types main.ts
// (requires MAKEFUN_ENV_URL to be set by the trial harness)

import { createApp } from './app.ts';

/** Base URL of the trial environment, with any trailing slashes removed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Longest a single register/done request is allowed to take. */
const REQUEST_LIMIT_MS = 30_000;
/** Wait before the first retry, and the longest wait between retries. */
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for retry `n` (0-based): doubles from FIRST_RETRY_MS, capped. */
function backoffMs(n: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(n, 8));
}

/**
 * Tell the environment the port the forge bound. A 200 means it accepted
 * the registration; a 409 means a registration already won and this
 * process simply waits like any other. 400/405 are contract errors and
 * are fatal. Anything else (network failure, other statuses) is retried,
 * because the environment may still be starting up.
 */
async function announcePort(port: number): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register rejected with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) throw err;
      // Network error or timeout: fall through to the retry below.
    }
    await pause(backoffMs(n));
  }
}

/** Keep asking the environment whether the trial is over; return once it is. */
async function waitUntilDone(): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet: keep polling.
    }
    await pause(backoffMs(n));
  }
}

async function run(): Promise<void> {
  if (envOrigin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no environment to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered with the environment\n');

  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[entry] environment signalled done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
