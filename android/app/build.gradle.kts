import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Release signing: a git-ignored android/keystore.properties (storeFile, storePassword,
// keyAlias, keyPassword) signs `release` when present. Without it, `release` is signed
// with the debug key so the APK is always installable (sideloaded, never on the Play Store).
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) keystorePropertiesFile.inputStream().use { load(it) }
}

android {
    namespace = "com.runninglivetracker"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.runninglivetracker"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    jvmToolchain(17)
}

// JVM contract tests read the shared fixtures straight from the repo (shared/fixtures).
val fixturesDir = rootProject.layout.projectDirectory.dir("../shared/fixtures").asFile.canonicalPath
tasks.withType<Test>().configureEach {
    systemProperty("fixturesDir", fixturesDir)
    inputs.dir(fixturesDir).withPropertyName("fixturesDir").withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.room.runtime)
    ksp(libs.room.compiler)
    implementation(libs.play.services.location)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
}
