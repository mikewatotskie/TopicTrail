package com.teamjam.topictrail.acceptance

import android.app.Application
import android.content.res.Configuration
import android.graphics.Typeface
import android.os.Build

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.common.build.ReactBuildConfig
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(StudyTransferPackage())
        },
      useDevSupport = BuildConfig.DEBUG && ReactBuildConfig.DEBUG
    )
  }

  override fun onCreate() {
    super.onCreate()
    val inter = Typeface.createFromAsset(assets, "fonts/Inter.ttf")
    val fontManager = ReactFontManager.getInstance()
    for ((alias, weight) in mapOf("Inter" to 400, "InterMedium" to 500, "InterSemiBold" to 600, "InterBold" to 700)) {
      val face = if (Build.VERSION.SDK_INT >= 28) Typeface.create(inter, weight, false)
                 else Typeface.create(inter, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
      fontManager.addCustomFont(alias, face)
    }
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
