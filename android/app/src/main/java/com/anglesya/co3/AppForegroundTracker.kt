package com.anglesya.co3

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.atomic.AtomicBoolean

object AppForegroundTracker : DefaultLifecycleObserver {

    private val foreground = AtomicBoolean(false)

    val isForeground: Boolean
        get() = foreground.get()

    override fun onStart(owner: LifecycleOwner) {
        foreground.set(true)
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground.set(false)
    }
}
