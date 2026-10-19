pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral() // Meta Wearables DAT has been published to Maven Central since 1.0 (no token needed)
  }
}

rootProject.name = "mnemo"
include(":app")
