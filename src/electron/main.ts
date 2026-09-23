import { createServer, type Server } from 'node:http';
import { cp, stat } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { createApp } from '../server/app.js';
import { pickRepository } from '../server/folder-picker.js';
import { ReviewStore } from '../server/store.js';

let window: BrowserWindow | undefined;
let server: Server | undefined;
let stopTasks: (() => void) | undefined;

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveDataDirectory(): Promise<string> {
  if (process.env.REVIEW_HELPER_DATA_DIR) return path.resolve(process.env.REVIEW_HELPER_DATA_DIR);
  if (!app.isPackaged) return path.join(app.getAppPath(), '.review-helper');

  const directory = path.join(app.getPath('userData'), 'reviews');
  const legacyDirectory = path.join(app.getPath('appData'), 'Source Review Helper', 'reviews');
  // 产品改名后只迁移审查记录；保留旧目录，避免升级失败时丢失原始数据。
  if (!(await directoryExists(directory)) && (await directoryExists(legacyDirectory)))
    await cp(legacyDirectory, directory, { recursive: true, force: false, errorOnExist: true });
  return directory;
}

// 桌面端沿用现有本机 API，只把目录选择换成 Electron 原生弹窗；取消仍不改变仓库路径。
async function start(): Promise<void> {
  // Finder 启动的进程可能缺少 Homebrew 路径；保留原 PATH 顺序并补上本机 CLI 的常见安装目录。
  if (process.platform === 'darwin')
    process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
      .filter(Boolean)
      .join(path.delimiter);
  const directory = await resolveDataDirectory();
  const { app: webApp, stop } = createApp({
    store: new ReviewStore(directory),
    repositoryPicker: () =>
      pickRepository(async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: '选择本地 Git 仓库',
          properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      }),
  });
  stopTasks = stop;
  const webRoot = path.join(app.getAppPath(), 'dist/web');
  webApp.use(express.static(webRoot));
  webApp.get('/', (_request, response) => response.sendFile(path.join(webRoot, 'index.html')));

  server = createServer(webApp);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      server!.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法确定本地服务端口。');
  const origin = `http://127.0.0.1:${address.port}`;

  window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Diff Wingman',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // 页面只能使用自己的本地服务；MR 的 HTTPS 链接在系统浏览器打开。
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    stopTasks?.();
    server?.closeAllConnections();
    server?.close();
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox('Diff Wingman 启动失败', String(error));
      app.quit();
    });
}
