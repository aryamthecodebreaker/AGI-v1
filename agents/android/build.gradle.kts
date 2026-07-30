// Root build file for the AGI Command Android agent.
//
// This module is NOT built by the repository's `npm run build` — it needs the
// Android SDK and Gradle. See docs/android-agent.md for how to build it.

plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
