package com.co3

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

class UpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        // 前台时不起 headless 任务：RN 前台启动 headless 会抛异常并崩进程
        // （详见 LibraryHeadlessService.onStartCommand 的注释）。
        // 返回 success 而不是 retry —— retry 会立刻重新排队、反复触发；App 开着时
        // 用户自己在用，等下一次周期触发即可。
        if (AppForegroundTracker.isForeground) return Result.success()
        // Start your custom HeadlessJsTaskService
        val intent = Intent(applicationContext, LibraryHeadlessService::class.java)
        applicationContext.startService(intent)
        return Result.success()
    }
}
