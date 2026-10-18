import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInventory, type MagpieModel } from '../src/catalog.js';
import { loadFastModelIDs } from '../src/fast-models.js';

const row: MagpieModel = {
  id: 'cursor/composer-2.5',
  owned_by: 'cursor',
  display_name: 'Composer 2.5',
  magpie_price: { input: 1, output: 5 },
  reasoning_levels: ['low', 'high'],
};
const baseURL = 'http://127.0.0.1:3425';
const paths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Fast model discovery', () => {
  it.each([
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
  ])('retains the wire model and reasoning settings on %s', (endpoint) => {
    const [normal, fast] = buildInventory(
      [{ ...row, native_endpoints: [endpoint], service_tiers: [{ id: 'priority' }] }],
      baseURL,
    )[0].models;
    expect(normal.id).toBe('composer-2.5');
    expect(normal.body).toBeUndefined();
    expect(fast).toEqual({
      ...normal,
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 Fast',
      cost: [{ input: 2.73, output: 13.23, cache: { read: 0.76, write: 0 } }],
      body: { service_tier: 'priority' },
    });
    expect(fast.modelID).toBe('cursor/composer-2.5');
    expect(fast.variants.map((variant) => variant.id)).toEqual(['low', 'high']);
  });

  it('requires explicit capability and refreshes away a removed capability', () => {
    for (const service_tiers of [undefined, [], ['default', 'flex', 'ultrafast']]) {
      expect(buildInventory([{ ...row, service_tiers }], baseURL)[0].models).toHaveLength(1);
    }
    expect(
      buildInventory([{ ...row, service_tiers: ['priority'] }], baseURL)[0].models,
    ).toHaveLength(2);
    expect(buildInventory([row], baseURL)[0].models).toHaveLength(1);
  });

  it('keeps existing upstream fast models regardless of list order and never doubles the suffix', () => {
    const normal = { ...row, service_tiers: ['priority'] };
    const fast = { ...normal, id: `${row.id}-fast`, display_name: 'Native Fast' };
    for (const rows of [
      [normal, fast],
      [fast, normal],
    ]) {
      const models = buildInventory(rows, baseURL)[0].models;
      expect(models).toHaveLength(2);
      expect(models.find((model) => model.id.endsWith('-fast'))).toMatchObject({
        modelID: fast.id,
        name: 'Native Fast',
      });
    }
  });

  it('preserves context SKUs and keeps unknown prices disabled', () => {
    const model = {
      ...row,
      id: 'other/unknown@200k',
      owned_by: 'other',
      display_name: 'Unknown',
      magpie_price: undefined,
      service_tiers: ['priority'],
    };
    const fast = buildInventory([model], baseURL)[0].models[1];
    expect(fast).toMatchObject({
      id: 'unknown@200k-fast',
      modelID: model.id,
      name: 'Unknown Fast (价格未知)',
      enabled: false,
      cost: [],
    });
  });

  it('derives advertised routing-group tiers without changing the route ID', () => {
    const models = buildInventory(
      [{ ...row, id: 'group/auto', magpie_price: undefined, service_tiers: ['priority'] }],
      baseURL,
    )[0].models;
    expect(models[1]).toMatchObject({ id: 'auto-fast', modelID: 'group/auto', enabled: true });
  });

  it('uses local plugin capabilities only for models currently exposed by the gateway', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-fast-'));
    paths.push(dir);
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    await mkdir(join(dir, 'magpie'));
    const path = join(dir, 'magpie', 'plugin-providers.json');
    await expect(loadFastModelIDs()).resolves.toEqual(new Set());
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'cursor',
          models: [
            { id: 'composer-2.5', fast: true },
            { id: 'hidden', fast: true },
          ],
        },
        {
          id: 'other',
          models: [
            { id: 'm', fast: true },
            { id: 'tiered', serviceTiers: ['priority'] },
          ],
        },
        null,
      ]),
    );
    const fastModelIDs = await loadFastModelIDs();
    expect(fastModelIDs).toEqual(new Set(['cursor/composer-2.5', 'cursor/hidden', 'other/tiered']));
    const models = buildInventory([row], baseURL, { fastModelIDs })[0].models;
    expect(models.map((model) => model.id)).toEqual(['composer-2.5', 'composer-2.5-fast']);
    await writeFile(path, '{');
    await expect(loadFastModelIDs()).resolves.toEqual(new Set());
  });
});
