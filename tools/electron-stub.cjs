/**
 * verify 脚本用的 Electron 最小替身。
 * crash-log 只用到 app.getPath('userData')；把它指到临时目录即可。
 */
const os = require('node:os')

exports.app = {
  getPath: () => os.tmpdir()
}
