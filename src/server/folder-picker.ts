import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AppError } from './errors.js';
import { git } from './git.js';

const exec = promisify(execFile);

// 由本机进程打开 macOS 原生目录框；浏览器无法向本地服务提供所选目录的绝对路径。
async function chooseMacFolder(): Promise<string | null> {
  if (process.platform !== 'darwin')
    throw new AppError(501, '当前系统暂不支持文件夹弹窗，请手动输入仓库路径。');
  // JXA 直接调用系统 AppKit，避免每次点击都由 swift -e 编译；osascript 会自动调用一次 run。
  const script = `ObjC.import('AppKit');
function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.finishLaunching;
  const panel = $.NSOpenPanel.openPanel;
  panel.setCanChooseFiles(false);
  panel.setCanChooseDirectories(true);
  panel.setAllowsMultipleSelection(false);
  panel.setMessage('选择本地 Git 仓库');
  app.activateIgnoringOtherApps(true);
  // JXA 的无参 Objective-C selector 以属性形式调用，不能写成 runModal()。
  if (panel.runModal == $.NSModalResponseOK) return ObjC.unwrap(panel.URL.path);
  return '';
}`;
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 300_000,
      maxBuffer: 8192,
    });
    return stdout.replace(/\r?\n$/, '') || null;
  } catch {
    throw new AppError(503, '无法打开系统文件夹弹窗，请手动输入仓库路径。');
  }
}

// 选择 Git 子目录时按现有 Git 读取规则定位仓库根目录；取消不改动当前路径。
export async function pickRepository(
  chooseFolder: () => Promise<string | null> = chooseMacFolder,
): Promise<string | null> {
  const selected = await chooseFolder();
  if (selected === null) return null;
  try {
    return await realpath((await git(selected, ['rev-parse', '--show-toplevel'])).toString().trim());
  } catch {
    throw new AppError(400, '所选文件夹不是可读取的 Git 仓库。');
  }
}
