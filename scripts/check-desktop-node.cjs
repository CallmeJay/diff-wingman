// 本机验收发现 Node 26 下 Forge 解压 Electron 提前结束；只使用已验证的 Node 22 打包。
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 12) {
  console.error('桌面版构建需要 Node.js 22.12+（22.x）。');
  process.exit(1);
}
