import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  spawn: vi.fn(),
  realpath: vi.fn(),
  delay: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: mocks.access,
  readFile: vi.fn(),
  realpath: mocks.realpath,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));

import {
  ensureGateway,
  findExecutable,
  gatewayArgs,
  INSTALL_MESSAGE,
  startAttempts,
} from '../src/gateway.js';

const platform = process.platform;
beforeEach(() => {
  mocks.realpath.mockImplementation(async (path) => path);
  vi.stubEnv('PATH', '/test-bin');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
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

it('opens the Magpie app on macOS, since only a window serves Magpie routing', () => {
  // A windowless `magpie serve` takes the port a window would use, and the app does not take it
  // back: it reports that routing cannot be watched there.
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    expect(gatewayArgs('/Applications/Magpie.app/Contents/MacOS/magpie')).toEqual(['tray']);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
  // A standalone CLI cannot open a window, so it keeps serving without one.
  expect(gatewayArgs('/opt/homebrew/bin/magpie')).toEqual(['serve']);
});

it('falls back to the windowless gateway when the app cannot open a window', () => {
  // A Mac reached over SSH, or one where OpenCode runs as a daemon, has no GUI session: `magpie
  // tray` exits without serving, so the windowless gateway has to remain a fallback.
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    expect(startAttempts('/Applications/Magpie.app/Contents/MacOS/magpie')).toEqual([
      ['tray'],
      ['serve'],
    ]);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
  expect(startAttempts('/opt/homebrew/bin/magpie')).toEqual([['serve']]);
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

it('resolves a PATH symlink to the app bundle before selecting tray', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.access.mockResolvedValue(undefined);
  mocks.realpath.mockResolvedValue('/Applications/Magpie.app/Contents/MacOS/magpie');
  expect(gatewayArgs((await findExecutable()) ?? '')).toEqual(['tray']);
  expect(mocks.realpath).toHaveBeenCalledWith('/test-bin/magpie');
});

it.each([
  'slow',
  'handoff',
  'failed',
] as const)('handles an app that is %s without racing the windowed gateway', async (mode) => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.access.mockResolvedValue(undefined);
  mocks.realpath.mockResolvedValue('/Applications/Magpie.app/Contents/MacOS/magpie');
  let running = false;
  let waits = 0;
  mocks.delay.mockImplementation(async () => {
    waits += 1;
    if (mode === 'slow' && waits === 40) running = true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!running) throw new TypeError('connection refused');
      return Response.json({ name: 'magpie' });
    }),
  );
  mocks.spawn.mockImplementation((_executable, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => {
      child.emit('spawn');
      if (args[0] === 'serve') running = true;
      else if (mode === 'failed') child.emit('exit', 1, null);
      else if (mode === 'handoff') child.emit('exit', 0, null);
    });
    return child;
  });
  if (mode === 'handoff') {
    await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('未启动无窗口服务');
  } else {
    await ensureGateway('http://127.0.0.1:3425');
  }
  expect(mocks.spawn.mock.calls.map((call) => call[1])).toEqual(
    mode === 'failed' ? [['tray'], ['serve']] : [['tray']],
  );
  if (mode === 'failed') expect(waits).toBe(0);
});

it('does not start serve when a live app times out', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.access.mockResolvedValue(undefined);
  mocks.realpath.mockResolvedValue('/Applications/Magpie.app/Contents/MacOS/magpie');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('未启动无窗口服务');
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
