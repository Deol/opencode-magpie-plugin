import { lookupCatalogPrice, type ModelsDevCatalog } from './catalog-cache.js';
import type { ModelPricingProvider } from './model-pricing.js';
import { getModelPricing } from './model-pricing.js';
import { type ModelInfo2, type ProviderInfo, toClassicModelInfo } from './opencode.js';

export type MagpieModel = {
  id: string;
  owned_by: string;
  display_name?: string;
  magpie_label?: string;
  context_window?: number;
  max_output_tokens?: number;
  native_endpoints?: string[];
  reasoning?: boolean;
  reasoning_levels?: string[];
  supported_reasoning_levels?: (string | { effort: string })[];
  service_tiers?: (string | { id: string })[];
  modalities?: { input?: string[]; output?: string[] };
  kind?: string;
  magpie_price?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
};

export type Inventory = { info: ProviderInfo; models: ModelInfo2[] }[];

/** Whether any model Magpie lists has no price in any source, which asks for a fresher catalog. */
export const hasUnpricedModel = (inventory: Inventory): boolean =>
  inventory.some((entry) => entry.models.some((model) => model.cost.length === 0));

/** Routing groups route across providers, so they belong to Magpie itself rather than to a vendor. */
const ROUTING_GROUP = 'magpie';

const reasoningVariants = (row: MagpieModel, anthropic: boolean): ModelInfo2['variants'] => {
  if (row.reasoning === false) return [];
  const levels =
    row.reasoning_levels ??
    row.supported_reasoning_levels?.map((level) =>
      typeof level === 'string' ? level : level.effort,
    ) ??
    [];
  return [...new Set(levels)]
    .filter((effort) => effort && effort !== 'default')
    .map((effort) => ({
      id: effort,
      settings: anthropic
        ? effort === 'none'
          ? { thinking: { type: 'disabled' } }
          : { thinking: { type: 'adaptive' }, effort }
        : { reasoningEffort: effort },
    }));
};

const pricingProvider = (owner: string): ModelPricingProvider | undefined => {
  const id = owner.toLowerCase();
  if (id === 'workbuddy') return 'codebuddy';
  return (['astra', 'boxai', 'codebuddy', 'cursor', 'imate', 'kalm'] as const).find(
    (provider) => provider === id,
  );
};

const providerName = (model: MagpieModel): string => {
  const label = model.magpie_label?.split(' · ').slice(1).join(' · ');
  if (label) return label;
  return (
    ({ cursor: 'Cursor', workbuddy: 'WorkBuddy' } as Record<string, string>)[model.owned_by] ??
    model.owned_by
  );
};

/**
 * How much a model is trusted to cost, in the order Magpie looks for a price:
 * the built-in table, then Magpie's own price, then the models.dev catalog.
 * Routing groups take Magpie's price only; their members are what Magpie routes to.
 */
export type PriceSource = 'builtin' | 'magpie' | 'models.dev' | 'none';

export type InventoryOptions = {
  /** The cached models.dev catalog, for models neither the built-in table nor Magpie prices. */
  catalog?: ModelsDevCatalog;
  fastModelIDs?: ReadonlySet<string>;
};

const modelCost = (
  row: MagpieModel,
  group: boolean,
  catalog: ModelsDevCatalog | undefined,
): { cost: unknown; source: PriceSource } => {
  const modelID = row.id.slice(row.id.indexOf('/') + 1);
  const pricingID = modelID.replace(/@\d+(?:k|m)$/i, '');
  const builtin = group ? undefined : getModelPricing(pricingID, pricingProvider(row.owned_by));
  if (builtin) return { cost: builtin, source: 'builtin' };
  if (row.magpie_price) return { cost: row.magpie_price, source: 'magpie' };
  const listed = group ? undefined : lookupCatalogPrice(catalog, row.owned_by, pricingID);
  if (listed) return { cost: listed, source: 'models.dev' };
  return { cost: undefined, source: 'none' };
};

export const buildInventory = (
  rows: MagpieModel[],
  baseURL: string,
  options: InventoryOptions = {},
): Inventory => {
  const providers = new Map<string, Inventory[number]>();
  const fastModelIDs = new Set(options.fastModelIDs);
  for (const row of rows) {
    if (
      row.service_tiers?.some((tier) => (typeof tier === 'string' ? tier : tier.id) === 'priority')
    )
      fastModelIDs.add(row.id);
  }
  rows
    .filter((row) => !row.kind && row.id.includes('/'))
    .forEach((row) => {
      const group = row.id.startsWith('group/');
      const owner = group ? ROUTING_GROUP : row.owned_by;
      // Names are the Magpie groups; IDs are namespaced so an existing Cursor plugin is not replaced.
      const providerID = `magpie-${encodeURIComponent(owner)}`;
      const modelID = row.id.slice(row.id.indexOf('/') + 1);
      const { cost } = modelCost(row, group, options.catalog);

      const model = toClassicModelInfo(providerID, modelID, {
        id: row.id,
        name: row.display_name ?? modelID,
        cost,
        limit: {
          context: row.context_window || 128_000,
          output: row.max_output_tokens || 32_000,
        },
        modalities: row.modalities,
        tool_call: true,
      });
      // An unknown price must not silently look like a free model: say so, and leave it out.
      // A routing group is the exception. Magpie reports a group price only when every member
      // costs the same, so a group that routes between differently priced models has no single
      // price to report — that is how the group is meant to work, not a discovery failure. It has
      // to stay selectable all the same, or routing across differently priced models, which is
      // the reason to build a group, would be impossible to use.
      if (!cost && !group) model.name += ' (价格未知)';
      model.enabled = !!cost || group;
      const anthropic = row.native_endpoints?.includes('/v1/messages');
      const responses = !anthropic && row.native_endpoints?.includes('/v1/responses');
      model.package = anthropic
        ? '@opencode/ai/providers/anthropic-compatible'
        : responses
          ? '@opencode/ai/providers/openai-compatible/responses'
          : '@opencode/ai/providers/openai-compatible';
      model.settings = {
        baseURL: `${baseURL}/v1`,
        apiKey: 'magpie',
        transport: 'http',
      };
      model.variants = reasoningVariants(row, !!anthropic);
      const entry = providers.get(providerID) ?? {
        info: {
          id: providerID,
          name: group ? 'Magpie' : providerName(row),
          activation: 'enabled' as const,
          package: '@opencode/ai/providers/openai-compatible',
          settings: {
            baseURL: `${baseURL}/v1`,
            apiKey: 'magpie',
            transport: 'http',
          },
          headers: {
            Authorization: 'Bearer magpie',
            'X-Magpie-Agent': 'opencode',
          },
        },
        models: [],
      };
      if (!entry.models.some((existing) => existing.id === model.id)) entry.models.push(model);
      providers.set(providerID, entry);
    });
  return [...providers.values()].map((entry) => {
    const ids = new Set(entry.models.map((model) => model.id));
    return {
      ...entry,
      models: entry.models.flatMap((model) => {
        if (
          !fastModelIDs.has(model.modelID) ||
          /-fast(?:@\d+[km])?$/i.test(model.id) ||
          ids.has(`${model.id}-fast`)
        )
          return [model];
        return [
          model,
          {
            ...model,
            id: `${model.id}-fast`,
            name: `${model.name.replace(/ \(价格未知\)$/, '')} Fast${model.enabled ? '' : ' (价格未知)'}`,
            body: { ...model.body, service_tier: 'priority' },
          },
        ];
      }),
    };
  });
};
