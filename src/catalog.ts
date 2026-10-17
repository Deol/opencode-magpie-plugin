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

export const buildInventory = (rows: MagpieModel[], baseURL: string): Inventory => {
  const providers = new Map<string, Inventory[number]>();
  rows
    .filter((row) => !row.kind && row.id.includes('/'))
    .forEach((row) => {
      const group = row.id.startsWith('group/');
      const owner = group ? row.id : row.owned_by;
      // Names are the Magpie groups; IDs are namespaced so an existing Cursor plugin is not replaced.
      const providerID = `magpie-${encodeURIComponent(owner)}`;
      const modelID = row.id.slice(row.id.indexOf('/') + 1);
      const pricingID = modelID.replace(/@\d+(?:k|m)$/i, '');
      const cost =
        (!group ? getModelPricing(pricingID, pricingProvider(owner)) : undefined) ??
        row.magpie_price;
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
      // An unknown price must not silently look like a free model.
      model.enabled = !!cost;
      if (!cost) model.name += ' (价格未知)';
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
          name: group ? (row.display_name ?? modelID) : providerName(row),
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
  return [...providers.values()];
};
