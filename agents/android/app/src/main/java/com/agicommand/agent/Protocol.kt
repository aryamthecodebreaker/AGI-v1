package com.agicommand.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * The AGI Command wire protocol, mirrored by hand from src/devices/protocol.ts.
 *
 * docs/device-protocol.md is the normative description for non-TypeScript
 * agents. If that document and this file disagree, the document wins and this
 * file is the bug.
 *
 * Two rules that the TypeScript agents get from shared types and this one has to
 * uphold deliberately:
 *   1. Never trust an inbound frame — every field is read defensively.
 *   2. Never log a frame containing `credential`.
 */
object Protocol {
    const val VERSION = "agi-command/1"
    const val MAX_MESSAGE_BYTES = 64 * 1024

    /** Only the major version has to match. */
    fun isCompatible(version: String?): Boolean {
        if (version == null) return false
        return major(version) == major(VERSION)
    }

    private fun major(version: String): String =
        version.substringAfter('/', "").substringBefore('.')

    // ---- outgoing ----

    private fun envelope(type: String): JSONObject =
        JSONObject()
            .put("v", VERSION)
            .put("type", type)
            .put("ts", System.currentTimeMillis())

    fun hello(
        credential: String,
        name: String,
        deviceType: String,
        platformVersion: String,
        agentVersion: String,
        capabilities: List<String>,
    ): String {
        val caps = JSONArray()
        capabilities.forEach { caps.put(JSONObject().put("name", it).put("version", 1)) }
        return envelope("agent.hello")
            .put("credential", credential)
            .put(
                "device",
                JSONObject()
                    .put("name", name)
                    .put("deviceType", deviceType)
                    .put("platform", "android")
                    .put("platformVersion", platformVersion)
                    .put("agentVersion", agentVersion),
            )
            .put("capabilities", caps)
            .toString()
    }

    fun heartbeat(): String = envelope("agent.heartbeat").toString()

    fun capabilities(names: List<String>): String {
        val caps = JSONArray()
        names.forEach { caps.put(JSONObject().put("name", it).put("version", 1)) }
        return envelope("agent.capabilities").put("capabilities", caps).toString()
    }

    fun acknowledged(commandId: String, executionId: String): String =
        envelope("command.acknowledged")
            .put("commandId", commandId)
            .put("executionId", executionId)
            .toString()

    fun completed(commandId: String, executionId: String, result: JSONObject): String =
        envelope("command.completed")
            .put("commandId", commandId)
            .put("executionId", executionId)
            .put("result", result)
            .toString()

    /** `code` must be one of: unsupported, rejected, failed, duplicate, invalid_parameters. */
    fun failed(commandId: String, executionId: String, code: String, message: String?): String =
        envelope("command.failed")
            .put("commandId", commandId)
            .put("executionId", executionId)
            .put("code", code)
            .apply { if (message != null) put("message", message.take(400)) }
            .toString()

    // ---- incoming ----

    data class Dispatch(
        val commandId: String,
        val executionId: String,
        val capability: String,
        val capabilityVersion: Int,
        val parameters: JSONObject,
        val timeoutMs: Long,
        val expiresAt: Long,
    )

    data class Welcome(
        val deviceId: String,
        val deviceName: String,
        val heartbeatIntervalMs: Long,
        val acceptedCapabilities: List<String>,
    )

    data class Cancel(val commandId: String, val executionId: String)

    data class ServerError(val code: String, val message: String?, val fatal: Boolean)

    sealed interface Inbound {
        data class WelcomeMessage(val welcome: Welcome) : Inbound
        data class DispatchMessage(val dispatch: Dispatch) : Inbound
        data class CancelMessage(val cancel: Cancel) : Inbound
        data class ErrorMessage(val error: ServerError) : Inbound
        data class Unreadable(val reason: String) : Inbound
    }

    fun parse(raw: String): Inbound {
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            return Inbound.Unreadable("frame exceeds size limit")
        }
        val json =
            try {
                JSONObject(raw)
            } catch (e: Exception) {
                return Inbound.Unreadable("not valid JSON")
            }
        if (!isCompatible(json.optString("v", null))) {
            return Inbound.Unreadable("incompatible protocol version")
        }
        return when (json.optString("type")) {
            "server.welcome" -> {
                val accepted = mutableListOf<String>()
                json.optJSONArray("acceptedCapabilities")?.let { array ->
                    for (i in 0 until array.length()) accepted.add(array.optString(i))
                }
                Inbound.WelcomeMessage(
                    Welcome(
                        deviceId = json.optString("deviceId"),
                        deviceName = json.optString("deviceName"),
                        heartbeatIntervalMs = json.optLong("heartbeatIntervalMs", 15_000),
                        acceptedCapabilities = accepted,
                    ),
                )
            }
            "command.dispatch" -> {
                val commandId = json.optString("commandId")
                val executionId = json.optString("executionId")
                val capability = json.optString("capability")
                if (commandId.isEmpty() || executionId.isEmpty() || capability.isEmpty()) {
                    Inbound.Unreadable("dispatch missing required fields")
                } else {
                    Inbound.DispatchMessage(
                        Dispatch(
                            commandId = commandId,
                            executionId = executionId,
                            capability = capability,
                            capabilityVersion = json.optInt("capabilityVersion", 1),
                            parameters = json.optJSONObject("parameters") ?: JSONObject(),
                            timeoutMs = json.optLong("timeoutMs", 15_000),
                            expiresAt = json.optLong("expiresAt", 0),
                        ),
                    )
                }
            }
            "command.cancel" ->
                Inbound.CancelMessage(
                    Cancel(json.optString("commandId"), json.optString("executionId")),
                )
            "server.error" ->
                Inbound.ErrorMessage(
                    ServerError(
                        code = json.optString("code"),
                        message = json.optString("message", null),
                        fatal = json.optBoolean("fatal", false),
                    ),
                )
            else -> Inbound.Unreadable("unknown message type")
        }
    }
}
