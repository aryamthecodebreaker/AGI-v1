package com.agicommand.agent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.PowerManager
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Android capability implementations.
 *
 * Everything here uses ordinary, documented Android APIs that the user has
 * granted through normal permission flows. There is deliberately no use of
 * Accessibility Services as a general remote-control mechanism, no root, no ADB
 * dependency, and nothing that touches the lock screen. Those are the honest
 * limits of what an app can do on Android, and the assistant reports capabilities
 * it cannot perform as unsupported rather than pretending.
 *
 * app.open resolves a symbolic id through a local allowlist and then through the
 * package manager. The server never sends a package name, an intent, or a
 * component — only an id like "youtube".
 */
class Capabilities(private val context: Context) {

    class Unsupported(message: String) : Exception(message)
    class Rejected(message: String) : Exception(message)

    companion object {
        const val NOTIFICATION_CHANNEL_ID = "agi_command_actions"

        /**
         * Symbolic app id -> candidate package names, tried in order.
         * An id that is not listed here is refused.
         */
        val APP_ALLOWLIST: Map<String, List<String>> =
            mapOf(
                "youtube" to listOf("com.google.android.youtube"),
                "gmail" to listOf("com.google.android.gm"),
                "maps" to listOf("com.google.android.apps.maps"),
                "calendar" to listOf("com.google.android.calendar"),
                "drive" to listOf("com.google.android.apps.docs"),
                "chrome" to listOf("com.android.chrome"),
                "spotify" to listOf("com.spotify.music"),
                "whatsapp" to listOf("com.whatsapp"),
                "keep" to listOf("com.google.android.keep"),
                "clock" to listOf("com.google.android.deskclock", "com.android.deskclock"),
                "settings" to listOf("com.android.settings"),
            )

        /** Everything this agent is willing to claim. */
        val ADVERTISED =
            listOf(
                "device.ping",
                "device.status",
                "battery.read",
                "app.open",
                "url.open",
                "media.play",
                "media.pause",
                "media.next",
                "media.previous",
                "volume.get",
                "volume.set",
                "volume.mute",
                "volume.unmute",
                "screen.wake",
                "notification.show",
            )
    }

    private val audioManager: AudioManager by lazy {
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }

    /** Dispatch one capability. Throws Unsupported / Rejected / Exception. */
    fun run(capability: String, parameters: JSONObject): JSONObject =
        when (capability) {
            "device.ping" -> JSONObject().put("roundTripMs", 0)
            "device.status" -> deviceStatus()
            "battery.read" -> batteryRead()
            "app.open" -> openApp(parameters.optString("appId"))
            "url.open" -> openUrl(parameters.optString("url"))
            "media.play" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PLAY)
            "media.pause" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE)
            "media.next" -> mediaKey(KeyEvent.KEYCODE_MEDIA_NEXT)
            "media.previous" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            "volume.get" -> volumeGet()
            "volume.set" -> volumeSet(parameters.optInt("percent", -1))
            "volume.mute" -> setMuted(true)
            "volume.unmute" -> setMuted(false)
            "screen.wake" -> wakeScreen()
            "notification.show" ->
                showNotification(
                    parameters.optString("title", "AGI-v1"),
                    parameters.optString("body", ""),
                )
            else -> throw Unsupported("$capability is not implemented on this device")
        }

    private fun batteryLevel(): Int {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    private fun isCharging(): Boolean {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return manager.isCharging
    }

    private fun batteryRead(): JSONObject =
        JSONObject()
            .put("batteryPercent", batteryLevel())
            .put("charging", isCharging())

    private fun deviceStatus(): JSONObject =
        JSONObject()
            .put("online", true)
            .put("batteryPercent", batteryLevel())
            .put("charging", isCharging())
            .put("volumePercent", currentVolumePercent())

    private fun openApp(appId: String): JSONObject {
        val candidates =
            APP_ALLOWLIST[appId.lowercase()]
                ?: throw Rejected("\"$appId\" is not in this device's app allowlist")

        for (packageName in candidates) {
            val intent = context.packageManager.getLaunchIntentForPackageCompat(packageName)
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return JSONObject().put("launched", true).put("package", packageName)
            }
        }
        throw Rejected("\"$appId\" is allowlisted but not installed on this device")
    }

    private fun openUrl(url: String): JSONObject {
        val uri = Uri.parse(url)
        // Re-check locally: the agent stays safe even pointed at another server.
        if (uri.scheme != "http" && uri.scheme != "https") {
            throw Rejected("only http and https URLs are allowed")
        }
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent.resolveActivity(context.packageManager) == null) {
            throw Rejected("no browser is available to open that link")
        }
        context.startActivity(intent)
        return JSONObject().put("opened", true)
    }

    /**
     * Media transport keys are delivered to whichever app currently holds audio
     * focus. If nothing is playing there is no session to control, and that is
     * reported rather than swallowed.
     */
    private fun mediaKey(keyCode: Int): JSONObject {
        if (!audioManager.isMusicActive) {
            throw Rejected("nothing is playing on this device")
        }
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
        return JSONObject().put("dispatched", true)
    }

    private fun currentVolumePercent(): Int {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (max <= 0) return 0
        val current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        return Math.round(current * 100f / max)
    }

    private fun volumeGet(): JSONObject =
        JSONObject()
            .put("volumePercent", currentVolumePercent())
            .put("muted", audioManager.isStreamMute(AudioManager.STREAM_MUSIC))

    private fun volumeSet(percent: Int): JSONObject {
        if (percent < 0 || percent > 100) throw Rejected("volume must be between 0 and 100")
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = Math.round(percent * max / 100f)
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        return JSONObject().put("volumePercent", currentVolumePercent())
    }

    private fun setMuted(muted: Boolean): JSONObject {
        audioManager.adjustStreamVolume(
            AudioManager.STREAM_MUSIC,
            if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
            0,
        )
        return JSONObject().put("muted", muted)
    }

    /**
     * Turns the screen on. It does NOT unlock the device, and there is no code
     * path here that could: the keyguard stays exactly where it is.
     */
    private fun wakeScreen(): JSONObject {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        val lock =
            power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "agi-command:wake",
            )
        lock.acquire(3000)
        if (lock.isHeld) lock.release()
        return JSONObject().put("woken", true).put("stillLocked", true)
    }

    private fun showNotification(title: String, body: String): JSONObject {
        val manager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "AGI Command actions",
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
        val notification =
            NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build()
        manager.notify(title.hashCode(), notification)
        return JSONObject().put("shown", true)
    }
}

/** Small compat shim so the call site stays readable across API levels. */
private fun PackageManager.getLaunchIntentForPackageCompat(packageName: String): Intent? =
    try {
        getLaunchIntentForPackage(packageName)
    } catch (e: Exception) {
        null
    }
