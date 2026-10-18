import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollabServer } from '../src/server.ts';

it('keeps two localhost app sessions independent, migrates legacy cookies, and survives a port change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-session-isolation-'));
  const fileA = join(root, 'a.sqlite');
  let a = createCollabServer({ stateFile: fileA });
  const b = createCollabServer({ stateFile: join(root, 'b.sqlite') });
  try {
    const addressA = await a.listen(0);
    const addressB = await b.listen(0);
    const start = async (launchUrl: string) => {
      const url = new URL(launchUrl);
      const response = await fetch(url.origin + '/bootstrap', { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ capability: url.hash.slice(1) }) });
      expect(response.status).toBe(200);
      const header = response.headers.get('set-cookie')!;
      expect(header).toContain('HttpOnly; SameSite=Strict; Path=/');
      return { origin: url.origin, cookie: header.split(';')[0]! };
    };
    const first = await start(addressA.launchUrl);
    const second = await start(addressB.launchUrl);
    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    const restore = (origin: string, cookie: string) => fetch(origin + '/session/restore', { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
    const sharedJar = `${first.cookie}; ${second.cookie}`;
    const restoredA = await restore(first.origin, sharedJar);
    const restoredB = await restore(second.origin, sharedJar);
    expect(restoredA.status).toBe(200);
    expect(restoredB.status).toBe(200);
    const cookieA = restoredA.headers.get('set-cookie')!.split(';')[0]!;
    const cookieB = restoredB.headers.get('set-cookie')!.split(';')[0]!;
    expect((await restore(second.origin, cookieA)).status).not.toBe(200);
    await a.close();
    a = createCollabServer({ stateFile: fileA });
    const restarted = await a.listen(0);
    const response = await restore(new URL(restarted.launchUrl).origin, `${cookieA}; ${cookieB}`);
    expect(response.status).toBe(200);
    const migratedCookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect(migratedCookie.split('=')[0]).toBe(cookieA.split('=')[0]);
    const legacy = `collab_session=${migratedCookie.split('=')[1]}`;
    const migrated = await restore(new URL(restarted.launchUrl).origin, legacy);
    expect(migrated.status).toBe(200);
    expect(migrated.headers.get('set-cookie')!.split('=')[0]).toBe(cookieA.split('=')[0]);
  } finally {
    await a.close();
    await b.close();
  }
}, 20_000);
