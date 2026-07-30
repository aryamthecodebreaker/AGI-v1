package com.agicommand.agent

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.Executors

/**
 * The agent's only screen: pair, see connection status, see recent commands,
 * toggle capabilities, unpair.
 *
 * Built programmatically rather than with XML layouts or Compose to keep the
 * agent a single small module with no view-binding or Compose toolchain. The UI
 * is deliberately plain — its job is to make the agent's state visible, which is
 * a trust requirement, not a design exercise.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusView: TextView
    private lateinit var historyView: TextView
    private lateinit var codeInput: EditText
    private lateinit var appUrlInput: EditText
    private lateinit var gatewayUrlInput: EditText
    private lateinit var deviceNameInput: EditText

    private val credentials by lazy { CredentialStore(applicationContext) }
    private val background = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var refresh: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(48, 64, 48, 48)
            }

        root.addView(
            TextView(this).apply {
                text = "AGI Command"
                textSize = 26f
            },
        )
        statusView =
            TextView(this).apply {
                text = "…"
                textSize = 15f
                setPadding(0, 16, 0, 32)
            }
        root.addView(statusView)

        deviceNameInput = field(root, "Device name", android.os.Build.MODEL)
        appUrlInput = field(root, "AGI-v1 URL", "http://10.0.2.2:3000")
        gatewayUrlInput = field(root, "Gateway URL", "ws://10.0.2.2:3100/agent")

        codeInput =
            field(root, "Pairing code", "").apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            }

        root.addView(
            Button(this).apply {
                text = "Pair this device"
                setOnClickListener { pair() }
            },
        )
        root.addView(
            Button(this).apply {
                text = "Start agent"
                setOnClickListener { AgentService.start(applicationContext) }
            },
        )
        root.addView(
            Button(this).apply {
                text = "Stop agent"
                setOnClickListener { AgentService.stop(applicationContext) }
            },
        )
        root.addView(
            Button(this).apply {
                text = "Unpair"
                setOnClickListener {
                    credentials.clear()
                    AgentService.stop(applicationContext)
                    toast("Credential removed. Revoke this device in AGI-v1 as well.")
                    render()
                }
            },
        )

        root.addView(
            TextView(this).apply {
                text = "Capabilities this device offers"
                textSize = 16f
                setPadding(0, 40, 0, 8)
            },
        )
        root.addView(
            TextView(this).apply {
                text = Capabilities.ADVERTISED.joinToString("\n") { "• $it" }
                textSize = 13f
            },
        )
        root.addView(
            TextView(this).apply {
                text =
                    "This agent cannot unlock your phone, bypass your PIN or biometrics, " +
                        "record audio or video, or run arbitrary commands. Those are not " +
                        "implemented and cannot be enabled from AGI-v1."
                textSize = 12f
                setPadding(0, 24, 0, 24)
            },
        )

        root.addView(
            TextView(this).apply {
                text = "Recent commands"
                textSize = 16f
                setPadding(0, 24, 0, 8)
            },
        )
        historyView = TextView(this).apply { textSize = 13f }
        root.addView(historyView)

        setContentView(
            ScrollView(this).apply {
                addView(
                    root,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            },
        )
    }

    override fun onResume() {
        super.onResume()
        // Poll rather than bind: the service is the source of truth and this
        // screen only needs to reflect it.
        refresh =
            object : Runnable {
                override fun run() {
                    render()
                    main.postDelayed(this, 1000)
                }
            }
        main.post(refresh!!)
    }

    override fun onPause() {
        super.onPause()
        refresh?.let { main.removeCallbacks(it) }
    }

    private fun render() {
        val stored = credentials.load()
        statusView.text =
            if (stored == null) {
                "Not paired. Enter a pairing code from AGI-v1."
            } else {
                "Paired as \"${stored.deviceName}\"\nStatus: ${AgentService.lastState}"
            }
        historyView.text =
            synchronized(AgentService.recentCommands) {
                if (AgentService.recentCommands.isEmpty()) "Nothing yet."
                else AgentService.recentCommands.joinToString("\n")
            }
    }

    private fun pair() {
        val code = codeInput.text.toString().trim()
        if (code.isEmpty()) {
            toast("Enter the pairing code shown in AGI-v1.")
            return
        }
        val appUrl = appUrlInput.text.toString().trim()
        val gatewayUrl = gatewayUrlInput.text.toString().trim()
        val name = deviceNameInput.text.toString().trim().ifEmpty { android.os.Build.MODEL }

        background.execute {
            try {
                AgentClient(
                    context = applicationContext,
                    credentials = credentials,
                    capabilities = Capabilities(applicationContext),
                    onState = { _, _ -> },
                    onCommand = { _, _ -> },
                )
                    .pair(appUrl, gatewayUrl, name, code)
                main.post {
                    // Clear the code immediately: it is single-use and spent.
                    codeInput.setText("")
                    toast("Paired. Starting agent…")
                    AgentService.start(applicationContext)
                    render()
                }
            } catch (e: Exception) {
                main.post { toast(e.message ?: "Pairing failed") }
            }
        }
    }

    private fun field(parent: LinearLayout, label: String, initial: String): EditText {
        parent.addView(
            TextView(this).apply {
                text = label
                textSize = 13f
                setPadding(0, 16, 0, 4)
            },
        )
        val input =
            EditText(this).apply {
                setText(initial)
                textSize = 15f
                gravity = Gravity.START
            }
        parent.addView(input)
        return input
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
