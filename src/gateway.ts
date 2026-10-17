import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MagpieModel } from './catalog.js';

export const INSTALL_MESSAGE =
  '未安装 Magpie，请先从 https://usemagpie.ai/zh/ 安装并登录所需服务，再使用此插件。';

export const resolveBaseURL = async (): Promise<string> => {
  if (process.env.MAGPIE_ADDR) {
    const addr = process.env.MAGPIE_ADDR.replace(/^:/, '127.0.0.1:');
    const url = new URL(addr.includes('://') ? addr : `http://${addr}`);
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Magpie 自动启动仅支持本机 MAGPIE_ADDR。');
    }
    return url.origin;
  }
  const path = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'magpie',
    'settings.json',
  );
  const settings: { port?: number } = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as { port?: number })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
  const port = settings.port || 3425;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Magpie settings.json 中的 port 无效。');
  return `http://127.0.0.1:${port}`;
};

export const findExecutable = async (): Promise<string | undefined> => {
  const binary = process.platform === 'win32' ? 'magpie.exe' : 'magpie';
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, binary)),
    join(homedir(), '.local', 'bin', binary),
    '/opt/homebrew/bin/magpie',
    '/usr/local/bin/magpie',
    '/Applications/Magpie.app/Contents/MacOS/magpie',
    join(homedir(), 'Applications/Magpie.app/Contents/MacOS/magpie'),
  ];
  const found = await Promise.all(
    candidates.map(
      async (path) =>
        await access(path, constants.X_OK).then(
          () => path,
          () => undefined,
        ),
    ),
  );
  return found.find(Boolean);
};

export const probeGateway = async (baseURL: string): Promise<boolean> => {
  let response: Response;
  try {
    response = await fetch(baseURL, { signal: AbortSignal.timeout(1500) });
  } catch {
    return false;
  }
  const info = (await response.json().catch(() => undefined)) as { name?: string } | undefined;
  if (!response.ok || info?.name !== 'magpie')
    throw new Error(`${baseURL} 已被非 Magpie 服务占用。`);
  return true;
};

const startGateway = async (executable: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const starting = new Map<string, Promise<void>>();

export const ensureGateway = async (baseURL: string): Promise<void> => {
  if (await probeGateway(baseURL)) return;
  const pending = starting.get(baseURL);
  if (pending) return pending;
  const task = (async () => {
    const executable = await findExecutable();
    if (!executable) throw new Error(INSTALL_MESSAGE);
    await startGateway(executable);
    const wait = async (remaining: number): Promise<void> => {
      if (await probeGateway(baseURL)) return;
      if (remaining === 0) throw new Error('Magpie 网关启动超时，请运行 magpie serve 查看错误。');
      await delay(500);
      return wait(remaining - 1);
    };
    await wait(30);
  })();
  starting.set(baseURL, task);
  try {
    await task;
  } finally {
    starting.delete(baseURL);
  }
};

export const fetchModels = async (baseURL: string): Promise<MagpieModel[]> => {
  const response = await fetch(`${baseURL}/v1/models`, {
    headers: { Authorization: 'Bearer magpie', 'X-Magpie-Prices': '1' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Magpie 模型发现失败：HTTP ${response.status}`);
  const body = (await response.json()) as { data?: MagpieModel[] };
  if (
    !Array.isArray(body.data) ||
    body.data.some((model) => typeof model.id !== 'string' || typeof model.owned_by !== 'string')
  ) {
    throw new Error('Magpie /v1/models 返回了无效的模型目录。');
  }
  return body.data;
};
