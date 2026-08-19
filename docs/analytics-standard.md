# 统一埋点规范 v1

适用：anglesgirl 旗下所有 APP（CO3 / Han1meViewer / 以后新 APP）。
原则：**不一次性大改，各 APP 发新版本时顺手对齐**。

## 1. 入口唯一
所有事件只走 `track(eventName, props)`，禁止直接调 `posthog.capture`。
`track()` 自动附加客户端上下文：
- `app`：应用标识（小写），如 `co3` / `han1meviewer`
- `app_version`
- `os` / `platform`

## 2. 分 app 字段
统一用 **`app`** 属性区分不同 APP。
- ✅ `properties['app'] = 'co3'`
- ❌ 不要再各自用 `$app_name` / `$app_namespace`
- 旧 APP（Han1meViewer 等）下个版本把上报字段从 `$app_name` 改对齐到 `app`

## 3. 用户维度统一字段
- `is_new_user`（布尔）：该设备**首次安装启动**时为 true，本地 AsyncStorage 标记一次后不再标
- 地域/国家**不自采**，统一用 PostHog 自动字段 `$geoip_country_name`（如 'China'）

## 4. 事件命名
小写 + 下划线，语义清晰：
- `app_launch`（启动）/ `app_active`（前台活跃心跳）/ `app_background`（后台）/ `app_crash`（崩溃）/ `app_uninstall`（卸载）
- 业务事件：`功能名_动作`，如 `search_click`

## 5. 属性值截断
字符串属性超 200 字符截断，防止把整段内容塞进埋点。

## 6. 开关
设置里提供采集开关，关闭时 `optOut()`，不阻塞 UI，异常静默。

## 7. 看板对应查询
- 分 app：`properties['app'] = 'xxx'`
- 新用户：`properties['is_new_user'] = true`
- 地域：`properties['$geoip_country_name'] = 'China'`
- 启动事件：CO3 系用 `app_launch`；旧 APP 用 `app_open` 的，下版本统一为 `app_launch`

## 迁移节奏
各 APP **发新版本时**顺手对齐以上字段，不单独发版改埋点。
先看板（posthog-viewer）已按此规范查询；旧数据字段不一致的部分历史报表会缺失，属正常。
