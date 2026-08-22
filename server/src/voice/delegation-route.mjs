import { createHash } from 'node:crypto'

const PERSONAL_DOMAIN = /(?:我的|我个人|私人|个人)(?:知识库|资料|信息|文件|文档|笔记|记忆|助理|助手|分身)|(?:知识库|分身|个人助理|私人助理|obsidian|notion|飞书|云盘)/i
const CURRENT_DATA = /(?:天气|气温|空气质量|路况|航班|火车|汇率|股价|币价|新闻|热搜|现在几点|今天几号|星期几|最新|实时|当前价格)/i
const TOOL_CAPABILITY = /(?:搜索|查询|查一下|打开|读取|查看|写入|修改|删除|创建|发送|下载|上传|运行|执行|操作)(?:.{0,12})(?:文件|目录|网页|网站|应用|日历|邮件|消息|代码|终端|电脑|屏幕|数据库)/i

export function delegationRoute(text, { hasFiles = false } = {}) {
  const intent = String(text || '').replace(/\s+/g, ' ').trim()
  if (hasFiles) return { decision: 'delegate', reason: 'file' }
  if (PERSONAL_DOMAIN.test(intent)) return { decision: 'delegate', reason: 'personal_domain' }
  if (CURRENT_DATA.test(intent)) return { decision: 'delegate', reason: 'current_data' }
  if (TOOL_CAPABILITY.test(intent)) return { decision: 'delegate', reason: 'tool_capability' }
  return { decision: 'direct', reason: 'self_contained' }
}

export function transcriptLogFields(text, route) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return {
    routeDecision: route.decision,
    routeReason: route.reason,
    intentFingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    intentLength: [...normalized].length,
  }
}
