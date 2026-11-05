import { permissionRisk, type PluginPermissionRisk } from '@shared/plugins'

export const RISK_LABEL: Record<PluginPermissionRisk, string> = {
  low: '低风险',
  mid: '中风险',
  high: '高风险'
}

interface PermissionHelp {
  access: string[]
  deny: string[]
}

const HELP: Record<string, PermissionHelp> = {
  storage: {
    access: ['本插件的配置、缓存与历史记录', '插件数据目录 userData/plugin-data/{plugin-id}'],
    deny: ['其他插件的存储', '宿主设置与 API Key', '工作区文件']
  },
  theme: {
    access: ['主题 token 与受限 CSS 的注入', '插件自己的状态栏标识样式'],
    deny: ['读取工作区文件', '读取会话内容', '执行外部命令']
  },
  i18n: {
    access: ['注册本插件的翻译资源'],
    deny: ['覆盖宿主内置文案', '读取会话内容']
  },
  events: {
    access: ['订阅其他插件发出的公开事件', '向事件总线发送本插件的事件'],
    deny: ['读取宿主内部状态', '访问其他插件的数据']
  },
  'ui:status-bar': {
    access: ['在底部状态栏渲染本插件的小组件或文字'],
    deny: ['读取会话内容', '读取工作区文件']
  },
  'ui:command': {
    access: ['向命令面板注册命令、标题与关键词'],
    deny: ['执行宿主内部命令', '读取其他插件的命令']
  },
  'ui:settings-section': {
    access: ['在设置页注册本插件的配置页'],
    deny: ['修改其他插件的设置', '读取宿主凭据']
  },
  'ui:panel-tab': {
    access: ['在主区注册一个带工作区上下文的页签'],
    deny: ['读取会话数据库', '修改聊天记录']
  },
  'ui:composer-status': {
    access: ['在输入框状态行渲染本插件组件'],
    deny: ['自动读取输入框草稿', '修改已发送的消息']
  },
  'ui:markdown': {
    access: ['向 Markdown 渲染管线注册组件'],
    deny: ['读取工作区文件', '读取会话数据库']
  },
  'ui:timeline-row': {
    access: ['为插件定义的聊天行类型渲染组件'],
    deny: ['读取完整会话历史', '修改其他消息']
  },
  'runtime.events.read': {
    access: ['轮次开始 / 结束事件', '工具调用名称与改动文件列表'],
    deny: ['完整会话历史', 'API 凭据']
  },
  'runtime.switch.observe': {
    access: ['模型 / 权限模式 / 思考深度的切换事件'],
    deny: ['修改当前会话配置', '读取 API 凭据']
  },
  'session.lifecycle.read': {
    access: ['当前打开会话的转写内容（只读）'],
    deny: ['修改或删除会话', '读取其他工作区的会话']
  },
  'workspace.metadata.read': {
    access: ['当前工作区的路径、名称与 worktree 信息'],
    deny: ['工作区文件内容', '其他工作区数据']
  },
  'host:models': {
    access: ['模型 id、显示名、上下文窗口与价格'],
    deny: ['API Key 与渠道凭据']
  },
  'host:session': {
    access: ['目标会话的 id、工作区与运行状态'],
    deny: ['完整转写（除非另有 session.lifecycle.read）', '修改其他会话']
  },
  'host:workspace': {
    access: ['侧栏工作区列表与 worktree 只读投影'],
    deny: ['工作区文件内容', '其他插件的私有 meta']
  },
  'host:worktree': {
    access: ['指定仓库的 worktree 路径与分支'],
    deny: ['任意文件读写', '推送到远端']
  },
  'host:window': {
    access: ['主窗口尺寸、位置与前台状态'],
    deny: ['窗口内的聊天内容', '其他应用窗口']
  },
  agent: {
    access: ['启动和中断本插件自己的 agent 轮次', '订阅本插件轮次的事件'],
    deny: ['接管用户手动启动的轮次', '读取 API Key']
  },
  'composer:draft': {
    access: ['把一段文字写入当前输入框草稿'],
    deny: ['自动发送消息', '读取输入框里的其他内容']
  },
  'network:none': {
    access: ['声明本插件不访问网络'],
    deny: ['任何网络请求（这不是授权）']
  }
}

export function permissionHelp(key: string): PermissionHelp {
  if (HELP[key]) return HELP[key]
  if (key.startsWith('network:')) {
    const host = key.slice('network:'.length)
    return {
      access: [`向 ${host} 发起 HTTPS 请求（仅此主机与端口）`],
      deny: ['其他域名', '读取本地文件', '执行外部命令']
    }
  }
  if (key.startsWith('exec:')) {
    const bin = key.slice('exec:'.length)
    return {
      access: [`以你的用户权限执行 ${bin}`, '继承当前工作区的环境变量与工作目录'],
      deny: ['其他可执行文件', '读取其他插件数据', '网络访问（需另声明 network:）']
    }
  }
  return {
    access: ['仅限该权限声明的范围'],
    deny: ['工作区文件', '其他插件数据']
  }
}

export function permissionRiskLabel(key: string): string {
  return RISK_LABEL[permissionRisk(key)]
}

const ERROR_TEXT: Record<string, string> = {
  'manifest-missing': '插件目录缺少 manifest.json',
  'manifest-unreadable': 'manifest.json 无法解析',
  'manifest-invalid-id': '插件 id 不合法：需要 2–64 位小写字母、数字或短横线',
  'manifest-invalid-version': '版本号不合法：需要 x.y.z',
  'manifest-invalid-tier': 'tier 只能是 declarative 或 js',
  'manifest-invalid-min-app-version': 'minAppVersion 不是合法版本号',
  'manifest-id-mismatch': 'manifest.id 与插件目录名不一致',
  'main-missing': '需要运行代码的插件缺少 main.js',
  'main-invalid': 'main.js 无法读取',
  'css-too-large': 'styles.css 超过 1MB',
  'plugin-too-large': '插件目录超过 16MB 或 2000 个文件',
  'source-not-directory': '选择的路径不是目录',
  'plugin-not-found': '插件不存在',
  'invalid-id': '插件 id 不合法',
  canceled: '已取消',
  'install-token-expired': '安装确认已过期，请重新选择插件目录',
  'market-unavailable': '市场索引暂时不可用',
  'market-index-invalid': '市场索引格式不正确',
  'market-plugin-not-found': '市场里找不到这个插件',
  'market-version-not-found': '市场里找不到这个版本',
  'market-id-mismatch': '下载包的 manifest.id 与市场条目不一致',
  'market-version-mismatch': '下载包的版本与市场条目不一致',
  'download-too-large': '插件包超过 32MB',
  'download-size-mismatch': '插件包大小与索引不一致',
  'download-sha256-mismatch': '插件包校验失败（sha256 不一致）',
  'invalid-download-url': '插件下载地址不合法',
  'zip-eocd-missing': '插件包不是合法的 zip',
  'zip64-unsupported': '暂不支持 zip64 插件包',
  'zip-too-many-entries': '插件包文件数量过多',
  'zip-too-large': '插件包解压后超过 64MB',
  'zip-path-traversal': '插件包包含越界路径',
  'zip-absolute-path': '插件包包含绝对路径',
  'zip-symlink-unsupported': '插件包不能包含符号链接',
  'zip-unsupported-compression': '插件包使用了不支持的压缩方式',
  'activate-missing': 'main.js 必须 export default function activate(ctx)',
  'plugin-api-unavailable': '插件服务不可用',
  'css-import-not-allowed': '插件 CSS 不能使用 @import',
  'css-remote-url-not-allowed': '插件 CSS 不能引用远程资源',
  'css-expression-not-allowed': '插件 CSS 不能使用 expression()',
  'storage-too-large': '插件存储超过 512KB',
  'value-too-large': '单个存储值超过 512KB',
  'invalid-key': '存储 key 不合法',
  'value-not-serializable': '存储值无法序列化'
}

export function pluginErrorText(code: string | undefined): string {
  if (!code) return ''
  if (ERROR_TEXT[code]) return ERROR_TEXT[code]
  if (code.startsWith('incompatible-app-version:')) {
    return `需要 CCoder v${code.slice('incompatible-app-version:'.length)} 或更高版本`
  }
  if (code.startsWith('manifest-unknown-permission:')) {
    return `未知权限：${code.slice('manifest-unknown-permission:'.length)}`
  }
  if (code.startsWith('manifest-duplicate-permission:')) {
    return `权限重复：${code.slice('manifest-duplicate-permission:'.length)}`
  }
  return code
}

export function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    theme: '主题',
    panel: '面板',
    workflow: '工作流',
    integration: '集成',
    language: '语言',
    render: '渲染'
  }
  return map[category] ?? category
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatInstalledAt(ms: number): string {
  if (!ms) return '未知'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString()
}
