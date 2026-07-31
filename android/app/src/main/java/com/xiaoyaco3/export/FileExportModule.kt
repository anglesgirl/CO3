package com.xiaoyaco3.export

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.Executors

class FileExportModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    private val io = Executors.newSingleThreadExecutor()

    override fun getName() = "FileExport"

    @ReactMethod
    fun saveToDownloads(sourcePath: String, displayName: String, mimeType: String, promise: Promise) {
        io.execute {
            try {
                val source = File(sourcePath)
                require(source.isFile) { "Source file does not exist" }
                require(displayName.isNotBlank() && '/' !in displayName && '\\' !in displayName) {
                    "Invalid download name"
                }
                val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveWithMediaStore(source, displayName, mimeType)
                } else {
                    saveLegacy(source, displayName)
                }
                promise.resolve(result)
            } catch (error: Throwable) {
                promise.reject("FILE_EXPORT_FAILED", error.message, error)
            }
        }
    }

    private fun saveWithMediaStore(source: File, displayName: String, mimeType: String): String {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, displayName)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CO3")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Unable to create download")
        try {
            resolver.openOutputStream(uri, "w")?.use { output ->
                FileInputStream(source).use { input -> input.copyTo(output) }
            } ?: error("Unable to open download")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri.toString()
        } catch (error: Throwable) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(source: File, displayName: String): String {
        val directory = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "CO3",
        )
        check(directory.exists() || directory.mkdirs()) { "Unable to create Download/CO3" }
        val target = uniqueFile(directory, displayName)
        FileInputStream(source).use { input ->
            FileOutputStream(target).use { output -> input.copyTo(output) }
        }
        return target.absolutePath
    }

    private fun uniqueFile(directory: File, displayName: String): File {
        val requested = File(directory, displayName)
        if (!requested.exists()) return requested
        val extension = requested.extension.takeIf { it.isNotEmpty() }?.let { ".$it" } ?: ""
        val base = requested.name.removeSuffix(extension)
        var index = 1
        while (File(directory, "$base ($index)$extension").exists()) index++
        return File(directory, "$base ($index)$extension")
    }
}
