import { buildInventory, hasUnpricedModel } from './catalog.js';
import { type CatalogCache, loadCatalogCache } from './catalog-cache.js';
import { loadFastModelIDs } from './fast-models.js';
import { ensureGateway, fetchModels, resolveBaseURL } from './gateway.js';
import { createTrackedSetup, type Plugin2, reloadProviderCatalog } from './opencode.js';

const plugin: Plugin2 = {
  id: 'magpie.providers',
  setup: (ctx) => setupPlugin(ctx),
};

export const setupPlugin: Plugin2['setup'] = async (ctx) => {
  if (!ctx.provider) throw new Error('Magpie 插件需要 OpenCode V2 provider.transform。');
  const baseURL = await resolveBaseURL();
  await ensureGateway(baseURL);
  let catalog: CatalogCache = await loadCatalogCache();
  let inventory = buildInventory(await fetchModels(baseURL), baseURL, {
    catalog: catalog.data,
    fastModelIDs: await loadFastModelIDs(),
  });
  const { track, cleanup } = createTrackedSetup();
  let disposed = false;
  let refreshing = false;
  try {
    await track(
      ctx.provider.transform((editor) => {
        inventory.forEach((entry) => {
          editor.add(entry);
        });
      }),
    );
    await track(
      ctx.session.hook('http.request', async (event) => {
        const url = new URL(event.request.url);
        if (url.origin !== baseURL || !url.pathname.startsWith('/v1/')) return;
        await ensureGateway(baseURL);
        event.request.headers.set('X-Magpie-Session', event.sessionID);
        event.request.headers.set('X-Magpie-Agent', 'opencode');
      }),
    );
    await reloadProviderCatalog(ctx);
  } catch (error) {
    await cleanup();
    throw error;
  }
  // Magpie reprices a model it cannot cost by refetching models.dev; this does
  // the same, so a model it lists but prices nowhere gets one on the next refresh
  // rather than waiting out the day-long catalog age.
  const apply = async (next: typeof inventory): Promise<void> => {
    if (disposed || JSON.stringify(next) === JSON.stringify(inventory)) return;
    const previous = inventory;
    inventory = next;
    try {
      await reloadProviderCatalog(ctx);
    } catch (error) {
      inventory = previous;
      throw error;
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      await ensureGateway(baseURL);
      const rows = await fetchModels(baseURL);
      catalog = await loadCatalogCache(hasUnpricedModel(inventory));
      const next = buildInventory(rows, baseURL, {
        catalog: catalog.data,
        fastModelIDs: await loadFastModelIDs(),
      });
      await apply(next);
    } catch (error) {
      console.warn(
        '[magpie] 模型刷新失败，保留上次目录：',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => {
    void refresh();
  }, 30_000);
  timer.unref();
  return async () => {
    disposed = true;
    clearInterval(timer);
    await cleanup();
  };
};

export default plugin;
