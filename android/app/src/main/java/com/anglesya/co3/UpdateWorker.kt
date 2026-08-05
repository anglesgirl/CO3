package com.anglesya.co3

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

class UpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        return try {
            // React Native 的 HeadlessJsTask 只允许后台运行。
            // App 在前台时 startService 会抛
            // IllegalStateException: Tried to start task while in foreground
            // → 闪退。前台时不启动任务，等下一个后台窗口再执行。
            if (!isAppInForeground()) {
                val intent = Intent(applicationContext, LibraryHeadlessService::class.java)
                applicationContext.startService(intent)
            }
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    private fun isAppInForeground(): Boolean {
        val activityManager = applicationContext
            .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val appProcesses = activityManager.runningAppProcesses ?: return false
        val packageName = applicationContext.packageName
        for (appProcess in appProcesses) {
            if (appProcess.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                && appProcess.processName == packageName
            ) {
                return true
            }
        }
        return false
    }
}
