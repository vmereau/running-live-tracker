// AGP 9 ships built-in Kotlin support (no kotlin-android plugin). Putting KGP on the
// build classpath pins the Kotlin version it uses to the catalog's `kotlin` (2.4.21)
// instead of the older one AGP depends on.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
