package com.co3.ech

import android.content.Context
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

object EchManager {
    private const val TAG = "ECH"
    private const val LOG_ENDPOINT = "https://log.anglesgirl.eu.org/v1/events"
    private const val TARGET_DOMAIN = "archiveofourown.org"
    private const val DOH_ENDPOINT = "https://82sew1c85i.cloudflare-gateway.com/dns-query"

    init {
        try {
            System.loadLibrary("echtls")
            Log.i(TAG, "ECH native lib loaded")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "ECH native lib not loaded: ${e.message}")
        }
    }

    fun init(context: Context) {
        Log.i(TAG, "ECH init for $TARGET_DOMAIN")
        Thread {
            try {
                val echConfig = fetchECHConfigViaDoH()
                if (echConfig != null) {
                    applyECHConfig(echConfig)
                    reportLog("ech_config_applied", mapOf("domain" to TARGET_DOMAIN, "config_length" to echConfig.size))
                } else {
                    reportLog("ech_config_fetch_failed", mapOf("domain" to TARGET_DOMAIN))
                }
            } catch (e: Exception) {
                Log.e(TAG, "ECH init error: ${e.message}")
                reportLog("ech_init_error", mapOf("error" to e.message ?: "unknown"))
            }
        }.start()
    }

    private fun fetchECHConfigViaDoH(): ByteArray? {
        try {
            val url = URL("$DOH_ENDPOINT?name=$TARGET_DOMAIN&type=65")
            val conn = url.openConnection() as HttpsURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.addRequestProperty("Accept", "application/dns-message")

            if (conn.responseCode == 200) {
                val inputStream = conn.inputStream
                val buffer = java.io.ByteArrayOutputStream()
                inputStream.copyTo(buffer)
                inputStream.close()
                val dnsResponse = buffer.toByteArray()
                return parseECHConfigFromDNS(dnsResponse)
            }
        } catch (e: Exception) {
            Log.e(TAG, "DoH fetch failed: ${e.message}")
        }
        return null
    }

    private fun parseECHConfigFromDNS(dnsResponse: ByteArray): ByteArray? {
        return null
    }

    private fun applyECHConfig(echConfig: ByteArray) {
        Log.i(TAG, "ECH config applied (stub): ${echConfig.size} bytes")
    }

    private fun reportLog(event: String, data: Map<String, Any>) {
        Thread {
            try {
                val url = URL(LOG_ENDPOINT)
                val conn = url.openConnection() as HttpsURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                conn.addRequestProperty("Content-Type", "application/json")
                conn.addRequestProperty("User-Agent", "CO3-ECH/1.0")

                val json = buildJson(event, data)
                conn.outputStream.write(json.toByteArray())
                conn.outputStream.close()
                val respCode = conn.responseCode
                Log.d(TAG, "Log reported: $event, code: $respCode")
            } catch (e: Exception) {
                Log.w(TAG, "Log report failed: ${e.message}")
            }
        }.start()
    }

    private fun buildJson(event: String, data: Map<String, Any>): String {
        val sb = StringBuilder()
        sb.append("{\"event\":\"").append(event).append("\",")
        sb.append("\"timestamp\":").append(System.currentTimeMillis()).append(",")
        sb.append("\"data\":{")
        val dataParts = data.map { (k, v) ->
            "\"$k\":${toJsonValue(v)}"
        }
        sb.append(dataParts.joinToString(","))
        sb.append("}}")
        return sb.toString()
    }

    private fun toJsonValue(value: Any): String = when (value) {
        is String -> "\"$value\""
        is Number, is Boolean -> value.toString()
        else -> "\"${value.toString()}\""
    }
}
