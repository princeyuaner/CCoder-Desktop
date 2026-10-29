/**
 * verify 脚本用的 Electron 替身：把 userData 指到测试临时目录。
 */
const os = require('node:os')

exports.app = {
  getPath: () => process.env.CCODER_TEST_USERDATA || os.tmpdir()
}
