import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(17)
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(
            type = providers.gradleProperty("platformType").get(),
            version = providers.gradleProperty("platformVersion").get(),
        )
        // Rider bundles the LSP module; depending on it exposes
        // LspServerSupportProvider, ProjectWideLspServerDescriptor, and the
        // LSP tool window integration.
        bundledModule("intellij.platform.lsp")

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
        gradleVersion = "8.11.1"
    }
}
