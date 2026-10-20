import { describe, expect, it } from 'vitest';
import { buildInventory, type MagpieModel, parsePresentation } from '../src/catalog.js';

const baseURL = 'http://127.0.0.1:3425';
const vendor: MagpieModel = { id: 'cursor/composer-2.5', owned_by: 'cursor' };
const auto: MagpieModel = { ...vendor, id: 'auto/composer-2.5' };

describe('Auto Group model IDs', () => {
  it.each([true, false])('keeps vendor models with auto-first=%s', (autoFirst) => {
    const inventory = buildInventory(autoFirst ? [auto, vendor] : [vendor, auto], baseURL);
    expect(inventory.find((entry) => entry.info.id === 'magpie-cursor')?.models[0]).toMatchObject({
      id: 'composer-2.5',
      modelID: vendor.id,
    });
    expect(inventory.find((entry) => entry.info.id === 'magpie-magpie')?.models[0]).toMatchObject({
      id: 'auto-composer-2.5',
      modelID: auto.id,
      cost: [],
    });
  });

  it.each([
    undefined,
    { input: 7, output: 21 },
  ])('keeps group pricing and wire IDs for bucketed Fast models (%j)', (magpie_price) => {
    const [entry] = buildInventory(
      [{ ...auto, magpie_price, service_tiers: ['priority'] }],
      baseURL,
      {
        presentation: parsePresentation({
          groups: [{ prefix: 'auto-', id: 'auto', name: 'Auto' }],
          order: { 'magpie-auto': ['composer-2.5'] },
        }),
      },
    );
    expect(entry.info).toMatchObject({ id: 'magpie-auto', name: 'Auto' });
    expect(entry.models).toHaveLength(2);
    expect(entry.models[1]).toMatchObject({
      id: 'composer-2.5-fast',
      modelID: auto.id,
      time: { released: 1000 },
      body: { service_tier: 'priority' },
      cost: entry.models[0].cost,
    });
    if (magpie_price) expect(entry.models[0].cost[0]).toMatchObject(magpie_price);
    else expect(entry.models[0].cost).toEqual([]);
  });

  it('does not use models.dev to guess a routing group price', () => {
    const [entry] = buildInventory([{ id: 'auto/catalog-only', owned_by: 'cursor' }], baseURL, {
      catalog: {
        cursor: {
          models: { 'catalog-only': { id: 'catalog-only', cost: { input: 3, output: 9 } } },
        },
      },
    });
    expect(entry.models[0].cost).toEqual([]);
  });
});
