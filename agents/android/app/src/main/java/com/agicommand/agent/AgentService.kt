package com.agicommand.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the gateway connection alive.
 *
 * A foreground service with a permanent notification is the honest way to hold a
 * long-lived socket on modern Android: the user can always see that the agent is
 * running and stop it. A background service would be killed by the OS, and
 * pretending otherwise would make the assistant report devices as online when
 * they are not reachable.
 */
class AgentService : Service() {

    companion object {
        private const val CHANNEL_ID = "agi_command_agent"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.agicommand.agent.STOP"

        @Volatile
        private var client: AgentClient? = null

        @Volatile
        var lastState: AgentClient.State = AgentClient.State.UNPAIRED
            private set

        /** Recent command outcomes, newest first, for the status screen. */
        val recentCommands = ArrayDeque<String>()

        fun start(context: Context) {
            val intent = Intent(context, AgentService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, AgentService::class.java).setAction(ACTION_STOP),
            )
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Starting…"))

        val credentials = CredentialStore(applicationContext)
        client =
            AgentClient(
                context = applicationContext,
                credentials = credentials,
                capabilities = Capabilities(applicationContext),
                onState = { state, detail ->
                    lastState = state
                    updateNotification(describe(state, detail))
                },
                onCommand = { capability, outcome ->
                    synchronized(recentCommands) {
                        recentCommands.addFirst("$capability → $outcome")
                        while (recentCommands.size > 20) recentCommands.removeLast()
                    }
                },
            )
        client?.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            client?.stop()
            stopForeground(true)
            stopSelf()
            return START_NOT_STICKY
        }
        // Restart if the OS kills us: a device that silently stops answering is
        // worse than one that reconnects.
        return START_STICKY
    }

    override fun onDestroy() {
        client?.stop()
        client = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun describe(state: AgentClient.State, detail: String?): String =
        when (state) {
            AgentClient.State.CONNECTED -> "Connected"
            AgentClient.State.CONNECTING -> "Connecting…"
            AgentClient.State.RECONNECTING -> "Reconnecting${detail?.let { " — $it" } ?: ""}"
            AgentClient.State.UNPAIRED -> "Not paired"
            AgentClient.State.REVOKED -> "Access revoked by AGI-v1"
            AgentClient.State.STOPPED -> "Stopped"
        }

    private fun createChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "AGI Command agent",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private fun buildNotification(status: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("AGI Command")
            .setContentText(status)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun updateNotification(status: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }
}
