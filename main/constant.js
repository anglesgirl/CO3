export const co3Version = "B1.0.31"

// ---- 匿名使用统计 (PostHog) ----
// 注册 PostHog 账号后,把 Project API Key 填到这里即可启用统计(形如 phc_xxx)。
// 留空则统计模块全程 no-op,不影响 App 运行。
export const POSTHOG_KEY = 'phc_nK8D285fUri5raFY7RFhztnYGqMukLNR6PfymaUB2R27';

// 统计请求地址。通过 EdgeOne 回源到 PostHog 官方(us.i.posthog.com),
// 隐藏 posthog 域名以绕过广告拦截。换回直连改成 https://us.i.posthog.com 即可。
export const POSTHOG_HOST = 'https://e.anglesya.win';

// 活跃心跳间隔。前台时每隔此时间上报一次 app_active,
// 用于活跃/留存/卸载(长期无心跳)推断。30 分钟。
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

// ---- App 更新检测 ----
// 启动时查询 GitHub latest release,跟本地 co3Version 对比。
// 发版时 create-release.yml 会自动把 tag 写进 co3Version,二者天然同步。
// 未认证 API 限流 60次/小时/IP,故每次查询后缓存 24h。
export const GITHUB_REPO = 'anglesgirl/CO3';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;