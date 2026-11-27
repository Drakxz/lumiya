plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val discordClientId = providers.gradleProperty("discordClientId").get()
val siteUrl = providers.gradleProperty("siteUrl").get()
require(discordClientId.matches(Regex("\\d{17,20}"))) { "discordClientId inválido" }
require(siteUrl.matches(Regex("https://[A-Za-z0-9.-]+(?::\\d{1,5})?"))) { "siteUrl deve ser uma origem HTTPS" }
val sdkAar = rootProject.file("../sdk/android/discord_partner_sdk.aar")
require(sdkAar.isFile) { "Instale o AAR oficial em native-app/sdk/android/discord_partner_sdk.aar" }

android {
  namespace = "com.sla.fotos"
  compileSdk = 35
  defaultConfig {
    applicationId = "com.sla.fotos"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"
    manifestPlaceholders["discordClientId"] = discordClientId
    buildConfigField("String", "DISCORD_CLIENT_ID", "\"$discordClientId\"")
    buildConfigField("String", "SITE_URL", "\"$siteUrl\"")
    externalNativeBuild {
      cmake {
        arguments += "-DDISCORD_SDK_INCLUDE_DIR=${rootProject.file("../sdk/include").absolutePath.replace('\\', '/')}"
        cppFlags += "-std=c++20"
      }
    }
    ndk { abiFilters += listOf("arm64-v8a") }
  }
  buildFeatures { buildConfig = true; prefab = true }
  externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  implementation(files(sdkAar))
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.browser:browser:1.8.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
