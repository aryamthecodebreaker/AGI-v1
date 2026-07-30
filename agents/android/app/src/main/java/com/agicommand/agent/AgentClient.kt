package com.agicommand.agent

import android.content.Context
import android.os.Build
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Android agent's connection to the device gateway.
 *
 * Mirrors agents/shared/agent.ts: connect, identify, heartbeat, execute, report,
 * reconnect with jittered backoff, and refuse replays. Two behaviours are worth
 * calling out because getting them wrong would be user-visible:
 *
 *   * A `fatal` server error (revoked credential, incompatible protocol) stops
 *     reconnection. Retrying forever against a server that has revoked you is
 *     just a battery drain.
 *   * A command is acknowledged before the work starts, so the server can tell
 *     "never arrived" apart from "arrived and is slow".
 */
class AgentClient(
    private val context: Context,
    private val credentials: CredentialStore,
    private val capabilities: Capabilities,
    private val onState: (State, String?) -> Unit,
    private val onCommand: (String, String) -> Unit,
) {
    enum class State { UNPAIRED, CONNECTING, CONNECTED, RECONNECTING, REVOKED, STOPPED }

    companion object {
        private const val TAG = "AgiCommandAgent"
        private const val AGENT_VERSION = "android-1.0.0"
        private const val RECONNECT_BASE_MS = 1_000L
        private const val RECONNECT_MAX_MS = 30_000L
        private const val DEDUPE_LIMIT = 200
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }

    private val http =
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val commandPool = Executors.newFixedThreadPool(4)

    /** Recently handled (commandId:executionId) pairs — replays are refused. */
    private val handled = ConcurrentHashMap.newKeySet<String>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()

    private var socket: WebSocket? = null
    private var state: State = State.UNPAIRED
    private var stopping = false
    private var reconnectAttempt = 0
    private var heartbeatIntervalMs = 15_000L

    fun currentState(): State = state

    private fun setState(next: State, detail: String? = null) {
        if (state == next) return
        state = next
        onState(next, detail)
    }

    // -----------------------------------------------------------------------
    // Pairing
    // -----------------------------------------------------------------------

    /**
     * Redeem a pairing code over HTTPS. Runs on the caller's background thread.
     * Throws with a user-presentable message on failure.
     */
    fun pair(appUrl: String, gatewayUrl: String, deviceName: String, code: String) {
        val body =
            JSONObject()
                .put("code", code)
                .put("name", deviceName)
                .put("deviceType", if (isTablet()) "android_tablet" else "android_phone")
                .put("platform", "android")
                .put("platformVersion", Build.VERSION.RELEASE)
                .put("agentVersion", AGENT_VERSION)
                .put("protocolVersion", Protocol.VERSION)
                .put(
                    "capabilities",
                    JSONArray().apply {
                        Capabilities.ADVERTISED.forEach {
                            put(JSONObject().put("name", it).put("version", 1))
                        }
                    },
                )

        val request =
            Request.Builder()
                .url("${appUrl.trimEnd('/')}/api/devices/pair")
                .post(body.toString().toRequestBody(JSON))
                .build()

        http.newCall(request).execute().use { response: Response ->
            val text = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                val message =
                    try {
                        JSONObject(text).optString("message", "pairing failed")
                    } catch (e: Exception) {
                        "pairing failed (${response.code})"
                    }
                throw IllegalStateException(message)
            }
            val json = JSONObject(text)
            credentials.save(
                credential = json.getString("credential"),
                deviceId = json.getString("deviceId"),
                deviceName = json.getString("deviceName"),
                gatewayUrl = gatewayUrl,
            )
            Log.i(TAG, "paired as ${json.getString("deviceName")}")
        }
    }

    fun unpair() {
        credentials.clear()
        stopping = true
        socket?.close(1000, "unpaired")
        setState(State.UNPAIRED)
    }

    // -----------------------------------------------------------------------
    // Connection
    // -----------------------------------------------------------------------

    fun start() {
        stopping = false
        connect()
    }

    fun stop() {
        stopping = true
        socket?.close(1000, "agent stopping")
        setState(State.STOPPED)
    }

    private fun connect() {
        if (stopping) return
        val stored = credentials.load()
        if (stored == null) {
            setState(State.UNPAIRED)
            return
        }
        setState(if (reconnectAttempt > 0) State.RECONNECTING else State.CONNECTING)

        val request = Request.Builder().url(stored.gatewayUrl).build()
        socket = http.newWebSocket(request, listener(stored))
    }

    private fun listener(stored: CredentialStore.Stored) =
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(
                    Protocol.hello(
                        credential = stored.credential,
                        name = stored.deviceName,
                        deviceType = if (isTablet()) "android_tablet" else "android_phone",
                        platformVersion = Build.VERSION.RELEASE,
                        agentVersion = AGENT_VERSION,
                        capabilities = Capabilities.ADVERTISED,
                    ),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                when (val inbound = Protocol.parse(text)) {
                    is Protocol.Inbound.WelcomeMessage -> {
                        reconnectAttempt = 0
                        heartbeatIntervalMs = inbound.welcome.heartbeatIntervalMs
                        setState(State.CONNECTED)
                        scheduleHeartbeat(webSocket)
                        Log.i(TAG, "connected as ${inbound.welcome.deviceName}")
                    }
                    is Protocol.Inbound.DispatchMessage ->
                        commandPool.execute { execute(webSocket, inbound.dispatch) }
                    is Protocol.Inbound.CancelMessage -> {
                        cancelled.add(
                            "${inbound.cancel.commandId}:${inbound.cancel.executionId}",
                        )
                    }
                    is Protocol.Inbound.ErrorMessage -> {
                        Log.w(TAG, "server error ${inbound.error.code}")
                        if (inbound.error.fatal) {
                            stopping = true
                            setState(
                                if (inbound.error.code == "unauthorized") State.REVOKED
                                else State.STOPPED,
                                inbound.error.message,
                            )
                        }
                    }
                    // Never log the frame itself — it may contain a credential.
                    is Protocol.Inbound.Unreadable ->
                        Log.w(TAG, "ignored unreadable frame: ${inbound.reason}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect(t.message ?: "connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!stopping && state != State.REVOKED) scheduleReconnect(reason)
            }
        }

    private fun scheduleHeartbeat(webSocket: WebSocket) {
        worker.scheduleWithFixedDelay(
            {
                if (state == State.CONNECTED) webSocket.send(Protocol.heartbeat())
            },
            heartbeatIntervalMs,
            heartbeatIntervalMs,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun scheduleReconnect(reason: String) {
        if (stopping || credentials.load() == null) return
        reconnectAttempt++
        val backoff =
            min(RECONNECT_BASE_MS shl (reconnectAttempt - 1), RECONNECT_MAX_MS)
        // Jitter, so every device on a network does not retry in lockstep.
        val delay = backoff / 2 + Random.nextLong(backoff / 2 + 1)
        setState(State.RECONNECTING, reason)
        worker.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    private fun execute(webSocket: WebSocket, dispatch: Protocol.Dispatch) {
        val key = "${dispatch.commandId}:${dispatch.executionId}"

        if (!handled.add(key)) {
            webSocket.send(
                Protocol.failed(
                    dispatch.commandId,
                    dispatch.executionId,
                    "duplicate",
                    "this command was already processed",
                ),
            )
            return
        }
        if (handled.size > DEDUPE_LIMIT) handled.iterator().let { if (it.hasNext()) { it.next(); it.remove() } }

        if (dispatch.expiresAt in 1 until System.currentTimeMillis()) {
            webSocket.send(
                Protocol.failed(
                    dispatch.commandId,
                    dispatch.executionId,
                    "rejected",
                    "the command had already expired when it arrived",
                ),
            )
            onCommand(dispatch.capability, "expired")
            return
        }

        if (!Capabilities.ADVERTISED.contains(dispatch.capability)) {
            webSocket.send(
                Protocol.failed(
                    dispatch.commandId,
                    dispatch.executionId,
                    "unsupported",
                    "${dispatch.capability} is not implemented on this device",
                ),
            )
            onCommand(dispatch.capability, "unsupported")
            return
        }

        webSocket.send(Protocol.acknowledged(dispatch.commandId, dispatch.executionId))

        if (cancelled.remove(key)) {
            webSocket.send(
                Protocol.failed(
                    dispatch.commandId,
                    dispatch.executionId,
                    "rejected",
                    "cancelled before it ran",
                ),
            )
            onCommand(dispatch.capability, "cancelled")
            return
        }

        try {
            val result = capabilities.run(dispatch.capability, dispatch.parameters)
            webSocket.send(Protocol.completed(dispatch.commandId, dispatch.executionId, result))
            onCommand(dispatch.capability, "completed")
        } catch (e: Capabilities.Unsupported) {
            webSocket.send(
                Protocol.failed(dispatch.commandId, dispatch.executionId, "unsupported", e.message),
            )
            onCommand(dispatch.capability, "unsupported")
        } catch (e: Capabilities.Rejected) {
            webSocket.send(
                Protocol.failed(dispatch.commandId, dispatch.executionId, "rejected", e.message),
            )
            onCommand(dispatch.capability, "rejected")
        } catch (e: Exception) {
            webSocket.send(
                Protocol.failed(
                    dispatch.commandId,
                    dispatch.executionId,
                    "failed",
                    e.message ?: "the action failed",
                ),
            )
            onCommand(dispatch.capability, "failed")
        }
    }

    private fun isTablet(): Boolean {
        val metrics = context.resources.configuration
        return metrics.smallestScreenWidthDp >= 600
    }
}
