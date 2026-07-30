plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.agicommand.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agicommand.agent"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Credential storage in the Android Keystore.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // WebSocket client for the gateway connection.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
