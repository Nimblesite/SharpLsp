import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    kotlin("jvm") version "2.0.21"
    // 2.14 is the current stable intellij-platform Gradle plugin release;
    // 2.2 was rejected by the platform with an "outdated" warning.
    id("org.jetbrains.intellij.platform") version "2.14.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

// Rider 2024.3 runs on JetBrains Runtime 21 and its platform jars are
// compiled against bytecode 21. Targeting 17 causes
// `sourceCompatibility='17' but ... requires sourceCompatibility='21'`
// at `verifyPluginProjectConfiguration`.
kotlin {
    jvmToolchain(21)
}
java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Rider 2024.3 is distributed as a .dmg/.exe installer only —
        // the intellij-platform plugin 2.14 requires `useInstaller = false`
        // to fall back to the .tar.gz / .zip archive resolver instead.
        rider(providers.gradleProperty("platformVersion").get()) {
            useInstaller = false
        }
        // The LSP API (com.intellij.platform.lsp.api.*) lives inside
        // Rider's main `lib/product.jar`, not in a separately-declarable
        // bundled module. It is already on the compile classpath once
        // we depend on the Rider platform; no extra directive required.
        // Declaring `bundledModule("intellij.platform.lsp")` fails with
        // "Specified bundledModule 'intellij.platform.lsp' doesn't exist"
        // on Rider 2024.3 — the module system lists only runtime-splittable
        // modules, and the LSP API isn't one of them.

        testFramework(TestFrameworkType.Platform)
    }

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            // Deliberately no untilBuild — we want the plugin to keep
            // working on future Rider builds. JetBrains recommends
            // omitting untilBuild unless you've explicitly seen a break.
            untilBuild = provider { null }
        }

        description =
            "Forge LSP for Rider — the open-source .NET language server " +
            "providing C# and F# intelligence powered by the forge-lsp " +
            "binary. Includes a Solution Explorer tool window mirroring " +
            "the VS Code experience."

        vendor {
            name = "Forge LSP"
            url = "https://github.com/forge-lsp/forge"
        }
    }

    publishing {
        // No marketplace publishing from this build — we only produce the
        // zip locally. Release automation lives in a separate workflow.
    }

    buildSearchableOptions = false
}

tasks {
    test {
        useJUnitPlatform()
    }

    // Let Gradle wire the wrapper task so `./gradlew wrapper` regenerates.
    wrapper {
        gradleVersion = "9.0.0"
    }
}
