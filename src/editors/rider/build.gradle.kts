import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.gradle.api.tasks.compile.AbstractCompile
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

// [DIST-CI-AUDIT] IntelliJ's build tooling still resolves vulnerable transitives.
// Keep their patched versions on the build classpath until upstream catches up.
buildscript {
    configurations.all {
        resolutionStrategy.force(
            "org.freemarker:freemarker:2.3.35", // GHSA-27j2-h3m2-8237
            "org.jsoup:jsoup:1.23.2", // GHSA-65r4-943x-97jj
            "com.fasterxml.jackson.core:jackson-core:2.21.7", // GHSA-7hhh-6rmp-j9qf
            "com.fasterxml.jackson.core:jackson-databind:2.21.7", // GHSA-cxp5-3px4-pw24
        )
    }
}

plugins {
    id("java")
    kotlin("jvm") version "2.4.21"
    // The 2.x plugin requires Gradle 9.0+, matching the wrapper pin.
    id("org.jetbrains.intellij.platform") version "2.19.0"
    // Line coverage for the Rider plugin, gated by the repo-wide ratchet in
    // coverage-thresholds.json. [DIST-CI-RIDER]
    id("org.jetbrains.kotlinx.kover") version "0.9.9"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

// [DIST-CI-ARTIFACT-TESTS] A new compile dependency must fail the consumer,
// never silently rebuild an artifact that was already handed off by CI.
if (providers.gradleProperty("prebuiltTests").isPresent) {
    gradle.taskGraph.whenReady {
        val compilers = allTasks.filter { it is AbstractCompile || it is KotlinJvmCompile }
        check(compilers.isEmpty()) { "Test phase contains compiler tasks: $compilers" }
    }
}

// Rider 2026.1 runs on JetBrains Runtime 21 and its platform jars are
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
    // The platform test framework registers `com.intellij.tests.
    // JUnit5TestSessionListener`, whose constructor loads `junit.framework.
    // TestCase`. Without JUnit 4 on the runtime classpath the listener fails to
    // instantiate and the whole test task dies before a single test runs --
    // NoClassDefFoundError, not a test failure. Required even though every test
    // here is JUnit 5.
    testRuntimeOnly("junit:junit:4.13.2")
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

        // [DIST-JETBRAINS-MARKETPLACE] The listing text. English first, links
        // live, and nothing claimed that the plugin does not do.
        description = """
            <p>Open-source C# and F# language intelligence from the
            <a href="https://github.com/Nimblesite/SharpLsp">SharpLsp</a> language
            server: Roslyn semantics for C#, the F# Compiler Service for F#.</p>
            <ul>
              <li>Completion, hover, diagnostics, go to definition, references,
                  rename and formatting through the IDE's LSP client</li>
              <li><b>SharpLsp Solution</b> tool window: solutions, projects,
                  dependencies and source files</li>
              <li><b>SharpLsp NuGet</b> tool window: browse, install and remove
                  packages</li>
            </ul>
            <p><b>Requires</b> the <code>sharplsp</code> server and the .NET 10 SDK.
            Install the server with <code>brew install nimblesite/tap/sharplsp</code>
            (macOS, Linux) or <code>scoop install nimblesite/sharplsp</code> (Windows),
            or unpack a <a href="https://github.com/Nimblesite/SharpLsp/releases">release
            archive</a>. Set a custom location at <i>Settings | Tools | SharpLsp</i>.</p>
        """.trimIndent()

        // Each release's notes are its GitHub release, which the tag stamps.
        changeNotes = providers.gradleProperty("pluginVersion").map { version ->
            "<p><a href=\"https://github.com/Nimblesite/SharpLsp/releases/tag/v$version\">" +
                "SharpLsp $version release notes</a></p>"
        }

        vendor {
            name = "Nimblesite"
            url = "https://github.com/Nimblesite/SharpLsp"
        }
    }

    // [DIST-JETBRAINS-MARKETPLACE] Optional vendor signature. signPlugin is
    // skipped unless all three are set; Marketplace countersigns every upload.
    signing {
        certificateChain = providers.environmentVariable("JETBRAINS_CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("JETBRAINS_PRIVATE_KEY")
        password = providers.environmentVariable("JETBRAINS_PRIVATE_KEY_PASSWORD")
    }

    // Marketplace accepts publishPlugin only after the first version was
    // uploaded by hand on plugins.jetbrains.com.
    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }

    // The Plugin Verifier Marketplace runs on every upload, run here first
    // against the Rider build this plugin compiles for.
    pluginVerification {
        ides {
            create(IntelliJPlatformType.Rider, providers.gradleProperty("platformVersion")) {
                useInstaller = false
            }
        }
    }

    buildSearchableOptions = false
}

tasks {
    test {
        useJUnitPlatform {
            // The platform test framework also puts junit-vintage on the
            // classpath, and that build is compiled against a newer
            // junit-platform-commons than junit-jupiter 5.11.3 ships
            // (`support.scanning.ClassFilter`). Vintage then dies during
            // DISCOVERY, which aborts the whole task before any test runs.
            // Every test here is JUnit 5, so only Jupiter is asked to discover.
            includeEngines("junit-jupiter")
        }

        // A `test` task that discovers nothing reports BUILD SUCCESSFUL. This
        // project had a fully configured test harness and not one test file for
        // its entire history, so the green was meaningless. Fail instead.
        failOnNoDiscoveredTests = true
    }

    // Let Gradle wire the wrapper task so `./gradlew wrapper` regenerates.
    wrapper {
        gradleVersion = "9.0.0"
    }
}
