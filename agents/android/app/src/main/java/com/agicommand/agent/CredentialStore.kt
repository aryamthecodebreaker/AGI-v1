package com.agicommand.agent

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Credential storage for the Android agent.
 *
 * The credential is held in EncryptedSharedPreferences, keyed by a MasterKey in
 * the Android Keystore, so it is encrypted at rest and unreadable to other apps.
 * It is never written to a log, never placed in an Intent extra, and only leaves
 * this class inside the agent.hello frame.
 */
class CredentialStore(context: Context) {

    data class Stored(
        val credential: String,
        val deviceId: String,
        val deviceName: String,
        val gatewayUrl: String,
        val pairedAt: Long,
    )

    private val prefs: SharedPreferences by lazy {
        val masterKey =
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
        EncryptedSharedPreferences.create(
            context,
            "agi_command_credentials",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun load(): Stored? {
        val credential = prefs.getString(KEY_CREDENTIAL, null) ?: return null
        val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: return null
        return Stored(
            credential = credential,
            deviceId = deviceId,
            deviceName = prefs.getString(KEY_DEVICE_NAME, "Android device") ?: "Android device",
            gatewayUrl = prefs.getString(KEY_GATEWAY_URL, "") ?: "",
            pairedAt = prefs.getLong(KEY_PAIRED_AT, 0),
        )
    }

    fun save(credential: String, deviceId: String, deviceName: String, gatewayUrl: String) {
        prefs
            .edit()
            .putString(KEY_CREDENTIAL, credential)
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_GATEWAY_URL, gatewayUrl)
            .putLong(KEY_PAIRED_AT, System.currentTimeMillis())
            .apply()
    }

    /** Local unpair. The server side still needs a revoke to be authoritative. */
    fun clear() {
        prefs.edit().clear().apply()
    }

    fun isPaired(): Boolean = load() != null

    private companion object {
        const val KEY_CREDENTIAL = "credential"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_NAME = "device_name"
        const val KEY_GATEWAY_URL = "gateway_url"
        const val KEY_PAIRED_AT = "paired_at"
    }
}
