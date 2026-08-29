package com.co3.ech
import android.content.Context
import android.util.Log
object EchManager {
    private const val TAG = "ECH"
    init { try { System.loadLibrary("echtls"); Log.i(TAG, "ECH native lib loaded") } catch (e: UnsatisfiedLinkError) { Log.e(TAG, "ECH load failed: ${e.message}") } }
    fun init(context: Context) { Log.i(TAG, "ECH initialized for archiveofourown.org") }
}
