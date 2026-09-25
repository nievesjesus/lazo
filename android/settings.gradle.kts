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
    mavenCentral() // Meta Wearables DAT se publica en Maven Central desde la 1.0 (sin token)
  }
}

rootProject.name = "mnemo"
include(":app")
