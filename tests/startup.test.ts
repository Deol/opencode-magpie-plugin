import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  readFile: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { ensureGateway, INSTALL_MESSAGE } from '../src/gateway.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('gives the installation URL when the gateway is down and no executable exists', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
  mocks.access.mockRejectedValue(new Error('ENOENT'));
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow(INSTALL_MESSAGE);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('starts one detached gateway for concurrent callers and verifies readiness', async () => {
  let running = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!running) throw new TypeError('connection refused');
      return Response.json({ name: 'magpie' });
    }),
  );
  mocks.access.mockResolvedValue(undefined);
  const unref = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref });
    queueMicrotask(() => {
      running = true;
      child.emit('spawn');
    });
    return child;
  });
  await Promise.all([
    ensureGateway('http://127.0.0.1:3425'),
    ensureGateway('http://127.0.0.1:3425'),
  ]);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(unref).toHaveBeenCalledOnce();
});

it('propagates a spawn failure and allows a later retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
  mocks.access.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('EACCES')));
    return child;
  });
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('EACCES');
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('EACCES');
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});
