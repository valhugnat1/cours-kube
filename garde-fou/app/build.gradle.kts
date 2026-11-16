plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.gardefou"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.gardefou"
        minSdk = 26 // Android 8
        targetSdk = 35
        // La CI passe le numéro du build : Android n'accepte une mise à jour que si
        // versionCode augmente.
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "0.1-dev"
    }

    signingConfigs {
        // Clé de signature commitée exprès : comme ça chaque APK construit (CI ou PC)
        // est signé pareil et s'installe par-dessus le précédent sans tout désinstaller.
        create("perso") {
            storeFile = rootProject.file("signature/gardefou.jks")
            storePassword = "gardefou"
            keyAlias = "gardefou"
            keyPassword = "gardefou"
        }
    }

    buildTypes {
        debug { signingConfig = signingConfigs.getByName("perso") }
        release {
            signingConfig = signingConfigs.getByName("perso")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    implementation(project(":core"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
}
