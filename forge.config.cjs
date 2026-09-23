module.exports = {
  packagerConfig: {
    name: 'Diff Wingman',
    icon: 'assets/app-icon',
    asar: true,
    // 只打包编译产物与运行依赖，避免把本地审查快照、测试和配置带进安装包。
    ignore: [/^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$)/],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
};
