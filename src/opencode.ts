/** Structural subset of the OpenCode V2 plugin API; the host supplies the runtime. */
export type Registration = { dispose: () => Promise<void> };

export type ProviderInfo = {
  id: string;
  name: string;
  activation: 'enabled';
  package: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type ModelInfo2 = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: {
    tools: boolean;
    input: readonly string[];
    output: readonly string[];
  };
  limit: { context: number; output: number };
  variants: readonly { id: string; settings?: Record<string, unknown> }[];
  status: 'active';
  enabled: boolean;
  time: { released: number };
  cost: readonly {
    input: number;
    output: number;
    cache: { read: number; write: number };
  }[];
  package?: string;
  settings?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

export type ProviderEditor = {
  add: (entry: { info: ProviderInfo; models: ModelInfo2[] }) => void;
};

export type PluginContext = {
  provider?: {
    transform: (callback: (editor: ProviderEditor) => void) => Promise<Registration>;
    reload: () => Promise<void>;
  };
  session: {
    hook: (
      name: 'http.request',
      callback: (event: { sessionID: string; request: Request }) => Promise<void>,
    ) => Promise<Registration>;
  };
};

export type Plugin2 = {
  id: string;
  setup: (ctx: PluginContext) => Promise<(() => Promise<void>) | void>;
};

export const createTrackedSetup = (): {
  track: (registration: Promise<Registration>) => Promise<void>;
  cleanup: () => Promise<void>;
} => {
  const registrations: Registration[] = [];
  return {
    track: async (registration) => {
      registrations.push(await registration);
    },
    cleanup: async () => {
      await registrations
        .splice(0)
        .reverse()
        .reduce(async (previous, registration) => {
          await previous;
          await registration.dispose().catch(() => {});
        }, Promise.resolve());
    },
  };
};

export const reloadProviderCatalog = async (ctx: PluginContext): Promise<void> => {
  await ctx.provider?.reload();
};

type ClassicModelEntry = {
  id: string;
  name: string;
  cost?: unknown;
  limit: { context: number; output: number };
  modalities?: { input?: readonly string[]; output?: readonly string[] };
  tool_call?: boolean;
};

/** USD per million tokens. Missing cache rates retain the original registry's zero fallback. */
export const normalizeModelCosts = (cost: unknown): ModelInfo2['cost'] => {
  if (!cost || typeof cost !== 'object') return [];
  const value = cost as {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
    cache_read?: number;
    cache_write?: number;
  };
  if (
    typeof value.input !== 'number' ||
    !Number.isFinite(value.input) ||
    typeof value.output !== 'number' ||
    !Number.isFinite(value.output)
  )
    return [];
  return [
    {
      input: value.input,
      output: value.output,
      cache: {
        read: value.cache?.read ?? value.cache_read ?? 0,
        write: value.cache?.write ?? value.cache_write ?? 0,
      },
    },
  ];
};

export const toClassicModelInfo = (
  providerID: string,
  catalogID: string,
  entry: ClassicModelEntry,
): ModelInfo2 => ({
  id: catalogID,
  modelID: entry.id,
  providerID,
  name: entry.name,
  capabilities: {
    tools: entry.tool_call !== false,
    input: entry.modalities?.input?.length ? entry.modalities.input : ['text'],
    output: entry.modalities?.output?.length ? entry.modalities.output : ['text'],
  },
  limit: { ...entry.limit },
  variants: [],
  status: 'active',
  enabled: true,
  time: { released: 0 },
  cost: normalizeModelCosts(entry.cost),
});
