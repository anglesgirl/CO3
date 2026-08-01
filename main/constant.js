export const co3Version = "B0.0.18"

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