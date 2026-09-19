package com.co3

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class LibraryHeadlessService : HeadlessJsTaskService() {

    /**
     * App 处于前台时**绝不能**启动 headless 任务。
     *
     * RN 的 HeadlessJsTaskContext.startTask 会检查：前台 + 本配置的
     * allowedInForeground=false → 直接抛
     *   IllegalStateException: Tried to start task LibraryUpdate while in foreground,
     *   but this is not allowed.
     * 而该异常抛在主线程 → 整个进程崩溃。2026-09-19 实测：进 App 后周期任务
     * 刚好触发，连崩两次，用户侧表现为「网络连接失败 / ECH 没启动」。
     *
     * 前台下 App 内有自己的更新逻辑可用，本次跳过即可，下一次周期触发会补上。
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (AppForegroundTracker.isForeground) {
            stopSelf()
            return START_NOT_STICKY
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        return HeadlessJsTaskConfig(
            "LibraryUpdate",
            Arguments.createMap(),
            120000,
            false
        )
    }
}