// Entry point: listen, register with the harness, wait for done, exit.
// Follows the kit starter's lifecycle exactly.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const port = Number.parseInt(process.env.PORT ?? '', 10) || 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  if (envUrl) {
    const register = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: address.port }),
    });
    if (!register.ok) throw new Error(`register failed: ${register.status}`);
    for (;;) {
      await sleep(500);
      const doneResponse = await fetch(`${envUrl}/done`);
      if (!doneResponse.ok) throw new Error(`done poll failed: ${doneResponse.status}`);
      const done = (await doneResponse.json()) as { done?: boolean };
      if (done.done) break;
    }
  } else {
    // No harness: stay up until killed (local development).
    await new Promise(() => undefined);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
