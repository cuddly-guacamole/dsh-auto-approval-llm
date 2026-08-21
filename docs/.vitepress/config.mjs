import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  lang: 'zh-CN',
  title: 'dsh-auto-approval-llm',
  description: 'DSH 自动审批 LLM 插件 · 工作原理详解',
  base: '/dsh-auto-approval-llm/',   // 仓库名，GitHub Pages 子路径部署必须
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '工作原理', link: '/01-system-overview' },
      { text: 'GitHub', link: 'https://github.com/cuddly-guacamole/dsh-auto-approval-llm' }
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '首页', link: '/' },
          { text: '01 系统总览', link: '/01-system-overview' }
        ]
      },
      {
        text: '核心管线',
        items: [
          { text: '02 工具调用生命周期', link: '/02-tool-call-lifecycle' },
          { text: '03 静态评估引擎', link: '/03-static-engine' },
          { text: '04 终局裁决管线', link: '/04-adjudicator-pipeline' }
        ]
      },
      {
        text: '决策与控制',
        items: [
          { text: '05 风险分档与倒计时', link: '/05-risk-matrix' },
          { text: '06 LLM 评审器', link: '/06-llm-reviewer' },
          { text: '07 人机竞速与超时仲裁', link: '/07-human-race' },
          { text: '08 熔断器状态机', link: '/08-breaker' }
        ]
      },
      {
        text: '安全与界面',
        items: [
          { text: '09 安全纵深九层', link: '/09-defense-in-depth' },
          { text: '10 客户端 UI', link: '/10-client-ui' },
          { text: '11 数据与持久化', link: '/11-data-persistence' },
          { text: '12 配置全景', link: '/12-config' },
          { text: '13 HTTP API', link: '/13-http-api' }
        ]
      },
      {
        text: '工程',
        items: [
          { text: '14 代码地图', link: '/14-code-map' },
          { text: '15 质量保障', link: '/15-quality' },
          { text: '16 设计公理', link: '/16-axioms' }
        ]
      }
    ],
    search: { provider: 'local' },   // 本地全文搜索 Ctrl+K
    outline: { level: [2, 3] },      // 右侧目录
    editLink: {
      pattern: 'https://github.com/cuddly-guacamole/dsh-auto-approval-llm/edit/main/docs/:path',
      text: '编辑此页'
    },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新', formatOptions: { dateStyle: 'short', timeStyle: 'medium' } }
  },
  mermaid: {
    // base 主题 + GitHub 风格变量：节点框用面板色而非 dark 主题的纯黑 #1f2020
    theme: 'base',
    themeVariables: {
      darkMode: true,
      background: '#0d1117',
      primaryColor: '#161b22',
      primaryBorderColor: '#30363d',
      primaryTextColor: '#c9d1d9',
      lineColor: '#8b949e',
      clusterBkg: '#161b22',
      clusterBorder: '#30363d',
      fontSize: '14px'
    }
  }        // vitepress-plugin-mermaid 配置
}))