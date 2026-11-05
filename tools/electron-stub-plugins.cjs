/** verify-plugins 用的 Electron 最小替身：市场模块只用到 net。 */
exports.net = {
  fetch: async () => {
    throw new Error('no-network-in-verify')
  }
}
exports.app = {
  getPath: () => require('node:os').tmpdir()
}
