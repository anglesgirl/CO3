package com.co3.ech

import android.content.Context
import android.util.Log
import org.anglesgirl.echtls.EchNative
import org.anglesgirl.echtls.EchProbeResult
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
            val available = EchNative.INSTANCE.isAvailable()
            val ver = EchNative.INSTANCE.version()
            val err = EchNative.INSTANCE.loadFailure()
            Log.i(TAG, "ECH native: available=$available, version=$ver, error=$err")
        } catch (e: Exception) {
            Log.e(TAG, "ECH native init error: ${e.message}")
        }
    }

    fun init(context: Context) {
        Log.i(TAG, "ECH init for $TARGET_DOMAIN")
        Thread {
            try {
                val echConfig = fetchECHConfigViaDoH()
                if (echConfig != null) {
                    probeECH(echConfig)
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

    private fun probeECH(echConfig: ByteArray) {
        if (!EchNative.INSTANCE.isAvailable()) {
            Log.e(TAG, "ECH native not available, skipping probe")
            return
        }
        try {
            val ips = listOf("104.18.0.1", "104.18.1.1", "172.64.146.66")
            for (ip in ips) {
                val result: EchProbeResult = EchNative.INSTANCE.probe(
                    host = TARGET_DOMAIN,
                    ip = ip,
                    port = 443,
                    echConfigList = echConfig,
                    requireEch = true,
                    timeoutMs = 10000
                )
                Log.i(TAG, "ECH probe $ip: $result")
                reportLog("ech_probe_result", mapOf(
                    "domain" to TARGET_DOMAIN,
                    "ip" to ip,
                    "connected" to result.connected.toString(),
                    "handshake_ok" to result.handshakeOk.toString(),
                    "ech_accepted" to result.echAccepted.toString(),
                    "tls_version" to result.tlsVersion,
                    "cipher" to result.cipher,
                    "error" to result.error
                ))
                if (result.echAccepted) {
                    Log.i(TAG, "ECH ACCEPTED on $ip!")
                    break
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "ECH probe error: ${e.message}")
            reportLog("ech_probe_error", mapOf("error" to e.message ?: "unknown"))
        }
    }

    private fun reportLog(event: String, data: Map<String, String>) {
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

    private fun buildJson(event: String, data: Map<String, String>): String {
        val sb = StringBuilder()
        sb.append("{\"event\":\"").append(event).append("\",")
        sb.append("\"timestamp\":").append(System.currentTimeMillis()).append(",")
        sb.append("\"data\":{")
        val dataParts = data.map { (k, v) -> "\"$k\":\"$v\"" }
        sb.append(dataParts.joinToString(","))
        sb.append("}}")
        return sb.toString()
    }
}
