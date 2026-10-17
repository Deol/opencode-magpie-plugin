import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Inventory } from '../src/catalog.js';
import { loadCatalogCache, readCatalogCache } from '../src/catalog-cache.js';
import { setupPlugin } from '../src/index.js';
import type { PluginContext, ProviderEditor } from '../src/opencode.js';

const servers: ReturnType<typeof createServer>[] = [];
const realFetch = globalThis.fetch;

const row = {
  id: 'relay/new-model',
  owned_by: 'relay',
  display_name: 'New Model',
  context_window: 100_000,
  max_output_tokens: 8_000,
  native_endpoints: ['/v1/chat/completions'],
};

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const gateway = async (models: () => unknown): Promise<string> => {
  const server = createServer((request, response) => {
    if (request.url === '/') return void response.end(JSON.stringify({ name: 'magpie' }));
    response.end(JSON.stringify({ data: models() }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const context = (onCatalog: (catalog: Inventory) => void): PluginContext => {
  let transform = (_editor: ProviderEditor) => {};
  return {
    provider: {
      transform: async (callback: typeof transform) => {
        transform = callback;
        return { dispose: async () => {} };
      },
      reload: async () => {
        const catalog: Inventory = [];
        transform({ add: (entry) => catalog.push(entry) });
        onCatalog(catalog);
      },
    },
    session: { hook: async () => ({ dispose: async () => {} }) },
  } as unknown as PluginContext;
};

const cacheWith = async (age: number, catalog: unknown): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'magpie-refresh-'));
  vi.stubEnv('XDG_CACHE_HOME', root);
  await mkdir(join(root, 'magpie'), { recursive: true });
  const path = join(root, 'magpie', 'models.json');
  await writeFile(path, JSON.stringify(catalog));
  const when = new Date(Date.now() - age);
  await utimes(path, when, when);
};

const serveModelsDev = (catalog: unknown): (() => number) => {
  let downloads = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://models.dev/')) return realFetch(input, init);
    downloads += 1;
    return Response.json(catalog);
  });
  return () => downloads;
};

describe('catalog refresh for a model Magpie cannot price', () => {
  it('bootstraps an empty cache once and adopts the downloaded price on refresh', async () => {
    vi.stubEnv('XDG_CACHE_HOME', await mkdtemp(join(tmpdir(), 'magpie-empty-')));
    vi.stubEnv('MAGPIE_ADDR', await gateway(() => [row]));
    const downloads = serveModelsDev({
      relay: { models: { 'new-model': { cost: { input: 3, output: 6 } } } },
    });
    const seen: Inventory[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await setupPlugin(context((catalog) => seen.push(catalog)));
    await vi.waitFor(async () => expect((await readCatalogCache()).stale).toBe(false));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(seen.at(-1)?.[0].models[0].cost[0]?.input).toBe(3));
    expect(downloads()).toBe(1);
    await cleanup?.();
  });

  it('refreshes a day-old priced catalog and deduplicates simultaneous refreshes', async () => {
    await cacheWith(25 * 60 * 60 * 1000, {
      relay: { models: { 'new-model': { cost: { input: 2, output: 4 } } } },
    });
    const downloads = serveModelsDev({
      relay: { models: { 'new-model': { cost: { input: 5, output: 10 } } } },
    });
    await Promise.all([loadCatalogCache(), loadCatalogCache(), loadCatalogCache()]);
    await vi.waitFor(async () =>
      expect((await readCatalogCache()).data?.relay.models?.['new-model'].cost?.input).toBe(5),
    );
    expect(downloads()).toBe(1);
  });
  it('refetches a stale models.dev catalog when a listed model has no price, then prices it', async () => {
    await cacheWith(7 * 60 * 60 * 1000, { relay: { models: {} } });
    const url = await gateway(() => [row]);
    vi.stubEnv('MAGPIE_ADDR', url);
    const downloads = serveModelsDev({
      relay: { models: { 'new-model': { id: 'new-model', cost: { input: 1, output: 4 } } } },
    });

    const seen: Inventory[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await setupPlugin(context((catalog) => seen.push(catalog)));
    expect(seen[0][0].models[0].enabled).toBe(false);
    expect(downloads()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(downloads()).toBe(1));
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen.at(-1)?.[0].models[0].enabled).toBe(true);
    });
    await vi.waitFor(() => expect(seen.at(-1)?.[0].models[0].enabled).toBe(true));
    expect(downloads()).toBe(1);
    expect(seen.at(-1)?.[0].models[0].cost[0]).toMatchObject({ input: 1, output: 4 });
    await cleanup?.();
  });

  it('prices from the cache without the network when the catalog is fresh', async () => {
    await cacheWith(60 * 1000, {
      relay: { models: { 'new-model': { id: 'new-model', cost: { input: 2, output: 5 } } } },
    });
    const url = await gateway(() => [row]);
    vi.stubEnv('MAGPIE_ADDR', url);
    const downloads = serveModelsDev({});

    const seen: Inventory[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await setupPlugin(context((catalog) => seen.push(catalog)));
    const model = seen[0][0].models[0];
    expect(model.enabled).toBe(true);
    expect(model.cost[0]).toMatchObject({ input: 2, output: 5 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(downloads()).toBe(0));
    expect(seen.at(-1)?.[0].models[0].cost[0]).toMatchObject({ input: 2, output: 5 });
    await cleanup?.();
  });

  it('serves the existing catalog when the refetch fails, without blocking or crashing', async () => {
    await cacheWith(7 * 60 * 60 * 1000, { relay: { models: {} } });
    const url = await gateway(() => [row]);
    vi.stubEnv('MAGPIE_ADDR', url);
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      if (!String(input).startsWith('https://models.dev/')) return realFetch(input, init);
      return new Response('down', { status: 503 });
    });

    const seen: Inventory[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await setupPlugin(context((catalog) => seen.push(catalog)));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await Promise.all([loadCatalogCache(true), loadCatalogCache(true)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.[0].models[0].enabled).toBe(false);
    warn.mockRestore();
    await cleanup?.();
  });
});
