import { afterEach, expect, it, vi } from 'vitest';
import { normalizeOpenAICallIDs } from '../src/call-ids.js';
import plugin from '../src/index.js';
import type { PluginContext } from '../src/opencode.js';

vi.mock('../src/gateway.js', () => ({
  resolveBaseURL: async () => 'http://127.0.0.1:3425',
  ensureGateway: async () => {},
  fetchModels: async () => [],
}));
vi.mock('../src/catalog-cache.js', () => ({ loadCatalogCache: async () => ({}) }));
vi.mock('../src/fast-models.js', () => ({ loadFastModelIDs: async () => new Set() }));

afterEach(() => vi.useRealTimers());

it('normalizes calls and results before transport for all OpenAI request kinds', async () => {
  vi.useFakeTimers();
  const hooks = new Map<string, { callback: unknown; options?: { providerID?: string } }>();
  const dispose = async () => {};
  const ctx = {
    provider: { transform: async () => ({ dispose }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: unknown, options?: { providerID?: string }) => {
        hooks.set(name, { callback, options });
        return { dispose };
      },
    },
  } as PluginContext;
  const cleanup = await plugin.setup(ctx);
  try {
    const id = `call_${'a'.repeat(77)}`;
    const messages = [
      { content: [{ type: 'tool-call', id, input: { text: id } }] },
      { content: [{ type: 'tool-result', id, output: id }] },
      { content: [{ type: 'tool-call', id: `${id.slice(0, -1)}b` }] },
      { content: [{ type: 'tool-call', id: 'a'.repeat(64) }] },
      { content: [{ type: 'text', id, text: id }] },
    ];
    let previous: typeof messages | undefined;
    for (const name of ['context', 'compaction', 'generate', 'title']) {
      const hook = hooks.get(name);
      expect(hook?.options).toEqual({ providerID: 'openai' });
      const callback = hook?.callback as typeof normalizeOpenAICallIDs;
      const event = { messages: structuredClone(messages) };
      callback(event);
      const parts = event.messages.map((m) => m.content[0]);
      expect(parts[0].id.length).toBeLessThanOrEqual(64);
      expect(parts[1].id).toBe(parts[0].id);
      expect(parts[2].id).not.toBe(parts[0].id);
      expect(parts[3].id).toBe('a'.repeat(64));
      expect(parts[4].id).toBe(id);
      expect(parts[0].input?.text).toBe(id);
      expect(parts[1].output).toBe(id);
      const once = structuredClone(event);
      callback(event);
      expect(event).toEqual(once);
      if (previous) expect(event.messages).toEqual(previous);
      previous = event.messages;
    }
    expect(messages[0].content[0].id).toBe(id);
    expect(hooks.has('experimental.ws.send')).toBe(false);
  } finally {
    await cleanup?.();
  }
});

it('uses the same ID for a separately replayed result and leaves native IDs unchanged', () => {
  const id = 'x'.repeat(82);
  const call = { messages: [{ content: [{ type: 'tool-call', id }] }] };
  const result = { messages: [{ content: [{ type: 'tool-result', id }] }] };
  normalizeOpenAICallIDs(call);
  normalizeOpenAICallIDs(result);
  expect(call.messages[0].content[0].id).toBe(result.messages[0].content[0].id);
  const native = { messages: [{ content: [{ type: 'tool-result', id: 'call_native' }] }] };
  normalizeOpenAICallIDs(native);
  expect(native.messages[0].content[0].id).toBe('call_native');
});
