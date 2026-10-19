import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.jetbrains.kotlin.android)
}

// Credentials from the Wearables Developer Center. In Developer Mode they can be "0".
val localProperties = Properties().apply {
  rootDir.resolve("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

android {
  namespace = "com.nievesjesus.mnemo"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.nievesjesus.mnemo"
    minSdk = 31
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    manifestPlaceholders["mwdat_application_id"] = localProperties.getProperty("mwdat_application_id", "0")
    manifestPlaceholders["mwdat_client_token"] = localProperties.getProperty("mwdat_client_token", "0")
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
  // ONNX models are not compressed inside the APK so they can be memory-mapped.
  androidResources { noCompress += "onnx" }
  sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/mnemoModels"))
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

// Copies ../../models/*.onnx (downloaded with scripts/download_models.sh) into the APK assets.
val copyModels by tasks.registering(Copy::class) {
  from(rootDir.resolve("../models")) { include("*.onnx") }
  into(layout.buildDirectory.dir("generated/mnemoModels/models"))
}
tasks.named("preBuild") { dependsOn(copyModels) }

dependencies {
  implementation(libs.appcompat)
  implementation(libs.lifecycle.runtime)
  implementation(libs.coroutines.android)
  implementation(libs.onnxruntime.android)
  implementation(libs.camerax.core)
  implementation(libs.camerax.camera2)
  implementation(libs.camerax.lifecycle)
  implementation(libs.mwdat.core)
  implementation(libs.mwdat.camera)
  implementation(libs.mwdat.mockdevice) // simulated glasses, to test without hardware
  testImplementation(libs.junit)
}
