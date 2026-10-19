import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInventory, type MagpieModel } from '../src/catalog.js';
import {
  catalogPrice,
  catalogSource,
  fetchCatalogCache,
  loadCatalogCache,
  lookupCatalogPrice,
  readCatalogCache,
} from '../src/catalog-cache.js';

// The shapes Magpie reads from models.dev: a maker's entry, a reseller standing for
// it through canonical_model_id, and a provider at another tariff under the same id.
const catalog = {
  deepseek: {
    id: 'deepseek',
    models: {
      'deepseek-flash': {
        id: 'deepseek-flash',
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        cost: { input: 0.66, output: 1.98, cache_read: 0.022 },
        canonical_model_id: 'deepseek/deepseek-v4-pro-0813',
      },
    },
  },
  cursor: {
    id: 'cursor',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', cost: { input: 1.25, output: 10 } },
    },
  },
  openrouter: {
    id: 'openrouter',
    models: {
      'deepseek/deepseek-v4.1-flash': {
        id: 'deepseek/deepseek-v4.1-flash',
        cost: { input: 0.07, output: 0.28 },
      },
    },
  },
};

const row = (owner: string, model: string): MagpieModel => ({
  id: `${owner}/${model}`,
  owned_by: owner,
  display_name: model,
  context_window: 200_000,
  max_output_tokens: 16_000,
  native_endpoints: ['/v1/chat/completions'],
});

const servers: ReturnType<typeof createServer>[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    if (!String(input).startsWith('http://127.0.0.1:'))
      return Promise.reject(new Error('External network forbidden in tests'));
    return realFetch(input, init);
  });
});
const serve = async (body: () => { status: number; text: string }): Promise<string> => {
  const server = createServer((_request, response) => {
    const { status, text } = body();
    response.statusCode = status;
    response.end(text);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const cacheRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'magpie-catalog-'));
  vi.stubEnv('XDG_CACHE_HOME', root);
  return root;
};

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

describe('models.dev price catalog', () => {
  it('prices a maker model through its canonical id, as DeepSeek lists V4.1 Flash', () => {
    expect(lookupCatalogPrice(catalog, 'deepseek', 'deepseek-v4.1-flash')).toEqual({
      input: 0.15,
      output: 0.6,
      cache: { read: 0.003, write: 0 },
    });
    expect(lookupCatalogPrice(catalog, 'deepseek', 'deepseek-flash')?.input).toBe(0.15);
  });

  it('only reads the maker catalog, never another provider tariff for the same model', () => {
    // openrouter lists deepseek/deepseek-v4.1-flash at 0.07; that is not DeepSeek's price.
    expect(lookupCatalogPrice(catalog, 'deepseek', 'deepseek-v4.1-flash')?.input).toBe(0.15);
    expect(lookupCatalogPrice(catalog, 'openrouter', 'deepseek/deepseek-v4.1-flash')?.input).toBe(
      0.07,
    );
    expect(lookupCatalogPrice(catalog, 'unknown', 'deepseek-v4.1-flash')?.input).toBe(0.15);
  });

  it('prices Cursor Muse models from Meta list prices when Magpie has none', () => {
    const priced = {
      ...catalog,
      meta: {
        models: {
          'muse-wonder-1.0': {
            id: 'muse-wonder-1.0',
            cost: { input: 4, output: 20, cache_read: 0.2 },
          },
          'muse-spark-1.3': {
            id: 'muse-spark-1.3',
            cost: { input: 1.25, output: 4.25, cache_read: 0.15 },
          },
        },
      },
      vercel: {
        models: {
          'muse-wonder-1.0': { id: 'muse-wonder-1.0', cost: { input: 9, output: 99 } },
        },
      },
    };
    expect(lookupCatalogPrice(priced, 'cursor', 'muse-wonder-1.0@300k')).toEqual({
      input: 4,
      output: 20,
      cache: { read: 0.2, write: 0 },
    });
    const models = buildInventory(
      [row('cursor', 'muse-wonder-1.0@300k'), row('cursor', 'muse-spark-1.3@1m')],
      'http://localhost:3425',
      { catalog: priced },
    )[0].models;
    expect(models.map((model) => [model.id, model.enabled, model.cost[0]?.input])).toEqual([
      ['muse-wonder-1.0@300k', true, 4],
      ['muse-spark-1.3@1m', true, 1.25],
    ]);
  });

  it('does not guess across versions or names', () => {
    expect(lookupCatalogPrice(catalog, 'deepseek', 'deepseek-v5')).toBeUndefined();
    expect(lookupCatalogPrice(undefined, 'deepseek', 'deepseek-flash')).toBeUndefined();
  });

  it('rejects conflicting canonical tariffs and subscription-plan zero prices', () => {
    const ambiguous = {
      deepseek: {
        models: {
          a: { canonical_model_id: 'deepseek/future', cost: { input: 1, output: 2 } },
          b: { canonical_model_id: 'deepseek/future', cost: { input: 3, output: 4 } },
        },
      },
    };
    expect(lookupCatalogPrice(ambiguous, 'deepseek', 'future')).toBeUndefined();
    expect(
      lookupCatalogPrice(
        { 'some-plan': { models: { x: { cost: { input: 0, output: 0 } } } } },
        'some-plan',
        'x',
      ),
    ).toBeUndefined();
    expect(catalogPrice({ input: -1, output: 2 })).toBeUndefined();
  });

  it('treats a zero price as a price and a malformed cost as none', () => {
    expect(catalogPrice({ input: 0, output: 0 })).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(catalogPrice({ output: 1 })).toBeUndefined();
    expect(catalogPrice({ input: Number.NaN, output: 1 })).toBeUndefined();
  });

  it('prices a Magpie model from the catalog only when the built-in table cannot', () => {
    // cursor/gpt-5.5 has a built-in price; a catalog tariff must not replace it.
    const builtin = buildInventory([row('cursor', 'gpt-5.5')], 'http://localhost:3425', {
      catalog,
    })[0].models[0];
    expect(builtin.cost[0].input).not.toBe(1.25);
    const listed = buildInventory([row('cursor', 'catalog-only-model')], 'http://localhost:3425', {
      catalog: {
        cursor: {
          models: {
            'catalog-only-model': { id: 'catalog-only-model', cost: { input: 3, output: 9 } },
          },
        },
      },
    })[0].models[0];
    expect(listed.enabled).toBe(true);
    expect(listed.cost[0]).toMatchObject({ input: 3, output: 9 });
  });

  it('keeps Magpie price ahead of the catalog and routing groups out of it', () => {
    const row1 = {
      ...row('unpriced-vendor', 'fresh-model'),
      magpie_price: { input: 0.2, output: 0.7 },
    };
    expect(
      buildInventory([row1], 'http://localhost:3425', { catalog })[0].models[0].cost[0].input,
    ).toBe(0.2);
    const group = { ...row('group', 'auto-deepseek-flash'), owned_by: 'unpriced-vendor' };
    expect(buildInventory([group], 'http://localhost:3425', { catalog })[0].models[0].cost).toEqual(
      [],
    );
  });
  it('reads Magpie cache first, then OpenCode cache, and reports staleness by file age', async () => {
    const root = await cacheRoot();
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(join(root, 'opencode', 'models.json'), JSON.stringify(catalog));
    const fallback = await readCatalogCache();
    expect(fallback.path).toBe(join(root, 'opencode', 'models.json'));
    expect(fallback.stale).toBe(false);
    await mkdir(join(root, 'magpie'), { recursive: true });
    await writeFile(
      join(root, 'magpie', 'models.json'),
      JSON.stringify({ deepseek: catalog.deepseek }),
    );
    const preferred = await readCatalogCache();
    expect(preferred.path).toBe(join(root, 'magpie', 'models.json'));
    expect(preferred.data).not.toHaveProperty('cursor');
    expect(await catalogSource()).toEqual({ path: preferred.path, age: expect.any(Number) });
  });

  it('downloads the catalog once and leaves the old file intact when a download fails', async () => {
    const root = await cacheRoot();
    const url = await serve(() => ({ status: 200, text: JSON.stringify(catalog) }));
    const saved = await fetchCatalogCache(url);
    expect(saved.path).toBe(join(root, 'opencode-magpie-plugin', 'models.json'));
    expect(JSON.parse(await readFile(saved.path, 'utf8'))).toHaveProperty('deepseek');

    const bad = await serve(() => ({ status: 500, text: 'nope' }));
    await expect(fetchCatalogCache(bad)).rejects.toThrow('HTTP 500');
    expect((await readCatalogCache()).data).toHaveProperty('deepseek');
    await expect(fetchCatalogCache(url, 1_000)).resolves.toHaveProperty('stale', false);
  });

  it('refreshes a stale cache in the background without blocking a reader', async () => {
    const root = await cacheRoot();
    await mkdir(join(root, 'magpie'), { recursive: true });
    await writeFile(
      join(root, 'magpie', 'models.json'),
      JSON.stringify({ deepseek: catalog.deepseek }),
    );
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(join(root, 'magpie', 'models.json'), old, old);
    const loaded = await loadCatalogCache();
    expect(loaded.stale).toBe(true);
    expect(loaded.data).toHaveProperty('deepseek');
  });
});
