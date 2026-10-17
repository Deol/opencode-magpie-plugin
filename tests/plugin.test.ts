import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInventory, type Inventory, type MagpieModel } from '../src/catalog.js';
import { ensureGateway, fetchModels, probeGateway, resolveBaseURL } from '../src/gateway.js';
import plugin from '../src/index.js';
import { getRequiredModelPricing } from '../src/model-pricing.js';
import type { PluginContext, ProviderEditor } from '../src/opencode.js';

vi.mock('../src/catalog-cache.js', async (original) => ({
  ...(await original<typeof import('../src/catalog-cache.js')>()),
  loadCatalogCache: async () => ({ data: undefined, path: '', stale: false }),
}));

const row = (owner: string, model = 'gpt-5.5'): MagpieModel => ({
  id: `${owner}/${model}`,
  owned_by: owner,
  display_name: model,
  magpie_label: `${model} · ${owner === 'cursor' ? 'Cursor' : 'WorkBuddy'}`,
  context_window: 200_000,
  max_output_tokens: 16_000,
});

const servers: ReturnType<typeof createServer>[] = [];
const serve = async (handler: Parameters<typeof createServer>[0]): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  vi.useRealTimers();
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

describe('Magpie discovery', () => {
  it('separates groups, retains wire IDs and reuses provider-specific shared prices', () => {
    const catalog = buildInventory([row('cursor'), row('workbuddy')], 'http://localhost:3425');
    expect(catalog.map((entry) => entry.info.name)).toEqual(['Cursor', 'WorkBuddy']);
    expect(catalog[0].info.id).not.toBe('cursor');
    expect(catalog[0].models[0].modelID).toBe('cursor/gpt-5.5');
    expect(catalog[0].models[0].cost[0]).toMatchObject(
      getRequiredModelPricing('gpt-5.5', 'cursor'),
    );
    expect(catalog[1].models[0].cost[0]).toMatchObject(
      getRequiredModelPricing('gpt-5.5', 'codebuddy'),
    );
  });

  it('groups every routing group under Magpie instead of a member provider', () => {
    const fast = {
      ...row('cursor'),
      id: 'group/fast',
      display_name: 'Fast',
      magpie_price: { input: 2, output: 8 },
    };
    // The live gateway reports the routing group's owned_by as one of its members.
    const auto = {
      ...row('workbuddy', 'auto'),
      id: 'group/auto',
      display_name: 'Auto',
      owned_by: 'workbuddy',
      magpie_price: { input: 1, output: 3 },
    };
    const catalog = buildInventory(
      [row('cursor'), row('workbuddy'), fast, auto],
      'http://localhost:3425',
    );
    expect(catalog.map((entry) => entry.info.name)).toEqual(['Cursor', 'WorkBuddy', 'Magpie']);
    const magpie = catalog[2];
    expect(magpie.info.id).toBe('magpie-magpie');
    expect(magpie.models.map((model) => model.modelID)).toEqual(['group/fast', 'group/auto']);
    expect(magpie.models[0].providerID).toBe('magpie-magpie');
    expect(magpie.models[0].cost[0]).toMatchObject({ input: 2, output: 8 });
    expect(catalog[0].models.map((model) => model.modelID)).toEqual(['cursor/gpt-5.5']);
    expect(catalog[1].models.map((model) => model.modelID)).toEqual(['workbuddy/gpt-5.5']);
  });

  it('preserves protocol, modalities, limits and reasoning choices', () => {
    const model = {
      ...row('cursor', 'claude-opus-4-6'),
      native_endpoints: ['/v1/messages'],
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning_levels: ['high'],
    };
    const result = buildInventory([model], 'http://localhost:3425')[0].models[0];
    expect(result.package).toBe('@opencode/ai/providers/anthropic-compatible');
    expect(result.capabilities.input).toEqual(['text', 'image']);
    expect(result.limit).toEqual({ context: 200_000, output: 16_000 });
    expect(result.variants[0].id).toBe('high');
  });

  it('does not mistake unknown pricing for free and ignores bare aliases and non-chat models', () => {
    const catalog = buildInventory(
      [
        row('cursor', 'unknown-model'),
        { ...row('cursor'), id: 'gpt-5.5' },
        { ...row('cursor', 'image-model'), kind: 'image' },
      ],
      'http://localhost:3425',
    );
    expect(catalog[0].models).toHaveLength(1);
    expect(catalog[0].models[0].enabled).toBe(false);
    expect(catalog[0].models[0].cost).toEqual([]);
  });

  it('probes identity and reads the gateway price extension', async () => {
    const url = await serve((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/') response.end(JSON.stringify({ name: 'magpie' }));
      else {
        expect(request.headers['x-magpie-prices']).toBe('1');
        response.end(JSON.stringify({ data: [row('cursor')] }));
      }
    });
    await expect(ensureGateway(url)).resolves.toBeUndefined();
    expect(await fetchModels(url)).toEqual([row('cursor')]);
  });

  it('rejects another service and malformed discovery instead of publishing an empty catalog', async () => {
    const url = await serve((_request, response) => response.end('{}'));
    await expect(probeGateway(url)).rejects.toThrow('非 Magpie');
    await expect(fetchModels(url)).rejects.toThrow('无效');
  });

  it('normalizes wildcard listen addresses to loopback', async () => {
    vi.stubEnv('MAGPIE_ADDR', '0.0.0.0:3426');
    expect(await resolveBaseURL()).toBe('http://127.0.0.1:3426');
    vi.stubEnv('MAGPIE_ADDR', 'example.com:3426');
    await expect(resolveBaseURL()).rejects.toThrow('本机');
  });

  it('refreshes added and removed providers, preserves inventory on failure and disposes hooks', async () => {
    let models = [row('cursor')];
    let failure = false;
    const url = await serve((request, response) => {
      if (request.url === '/') return void response.end(JSON.stringify({ name: 'magpie' }));
      response.statusCode = failure ? 503 : 200;
      response.end(JSON.stringify({ data: models }));
    });
    vi.stubEnv('MAGPIE_ADDR', url);
    let transform: (editor: ProviderEditor) => void = () => {};
    let catalog: Inventory = [];
    let hook: (event: { sessionID: string; request: Request }) => Promise<void> = async () => {};
    const dispose = vi.fn(async () => {});
    const reload = vi.fn(async () => {
      catalog = [];
      transform({
        add: (entry: Inventory[number]) => catalog.push(entry),
      } as ProviderEditor);
    });
    const ctx = {
      provider: {
        transform: async (callback: typeof transform) => {
          transform = callback;
          return { dispose };
        },
        reload,
      },
      session: {
        hook: async (_name: string, callback: typeof hook) => {
          hook = callback;
          return { dispose };
        },
      },
    } as unknown as PluginContext;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await plugin.setup(ctx);
    expect(catalog[0].info.name).toBe('Cursor');
    const request = new Request(`${url}/v1/chat/completions`);
    await hook({ sessionID: 'session-test', request });
    expect(request.headers.get('X-Magpie-Session')).toBe('session-test');
    const other = new Request('https://example.com/v1/chat/completions');
    await hook({ sessionID: 'session-test', request: other });
    expect(other.headers.has('X-Magpie-Session')).toBe(false);
    models = [row('workbuddy')];
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(catalog[0].info.name).toBe('WorkBuddy'));
    failure = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(catalog[0].info.name).toBe('WorkBuddy');
    warn.mockRestore();
    await cleanup?.();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
