const fs = require('fs')
const path = require('path')
const { AndroidConfig, XML, withDangerousMod } = require('expo/config-plugins')

/**
 * Theme-based colors for the Android system bars (status + navigation).
 *
 * Navigation bar:
 *   React Native calls Window.enableEdgeToEdge()
 *   (react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/WindowUtil.kt) for the
 *   activity and for every modal window. It sets navigationBarColor to transparent and then
 *   enables the platform's navigation bar contrast scrim, which paints a translucent white overlay
 *   (alpha 0xe6) over the bar unless the theme sets android:enforceNavigationBarContrast to false.
 *   On the app's light background (#f7f7f9) that scrim reads as a separate #fefefe strip above the
 *   nav buttons. Opting out keeps the bar fully transparent so the screen background shows
 *   through. While the scrim is enabled React Native picks the nav button style itself, so once it
 *   is disabled the theme's android:windowLightNavigationBar value keeps the nav buttons dark in
 *   light mode and light in dark mode.
 *
 * Status bar:
 *   Nothing in the app renders a <StatusBar> component; the icon color is applied at runtime by
 *   react-native-screens (ScreenWindowTraits.kt), which can miss re-applying it after a reload or
 *   reinstall and leave white icons on the light background. Defining
 *   android:windowLightStatusBar in the theme guarantees the correct icon color the moment any
 *   window (activity or dialog) is created; the runtime trait then only has to refine it.
 *
 * The values live in version-qualified resource folders because the attributes were added in API
 * 23 (android:windowLightStatusBar), API 27 (android:windowLightNavigationBar) and API 29
 * (android:enforceNavigationBarContrast). ui mode (values-night) has higher resource precedence
 * than platform version (values-vNN), so the dark-mode values win on every device that supports
 * them.
 */
const SYSTEM_BAR_STYLE_DIRS = [
  {
    dir: 'values-v23',
    items: [
      { name: 'android:windowLightStatusBar', value: 'true', targetApi: '23' },
    ],
  },
  {
    dir: 'values-v27',
    items: [
      { name: 'android:windowLightNavigationBar', value: 'true', targetApi: '27' },
    ],
  },
  {
    dir: 'values-v29',
    items: [
      { name: 'android:enforceNavigationBarContrast', value: 'false', targetApi: '29' },
    ],
  },
  {
    dir: 'values-night',
    items: [
      { name: 'android:windowLightStatusBar', value: 'false', targetApi: '23' },
      { name: 'android:windowLightNavigationBar', value: 'false', targetApi: '27' },
      { name: 'android:enforceNavigationBarContrast', value: 'false', targetApi: '29' },
    ],
  },
]

const TOOLS_XMLNS = { 'xmlns:tools': 'http://schemas.android.com/tools' }

async function readStylesXml(file) {
  if (!fs.existsSync(file)) {
    return { resources: {} }
  }
  return XML.parseXMLAsync(fs.readFileSync(file, 'utf8'))
}

/**
 * The qualified folders only override single items, but a style's parent attribute is resolved
 * from the best-matching configuration. Copy the base AppTheme parent so the overrides never
 * change which theme the app actually resolves.
 */
async function getBaseAppThemeParent(androidProjectRoot) {
  const xml = await readStylesXml(
    path.join(androidProjectRoot, 'app/src/main/res/values/styles.xml'),
  )
  const appTheme = AndroidConfig.Styles.getStyleParent(
    xml,
    AndroidConfig.Styles.getAppThemeGroup(),
  )
  return appTheme?.$?.parent ?? null
}

async function ensureSystemBarItemStyles(androidProjectRoot, { dir, items, appThemeParent }) {
  const file = path.join(androidProjectRoot, 'app/src/main/res', dir, 'styles.xml')
  const xml = await readStylesXml(file)

  for (const spec of items) {
    AndroidConfig.Styles.setStylesItem({
      xml,
      parent: { name: 'AppTheme', parent: appThemeParent },
      item: AndroidConfig.Resources.buildResourceItem(spec),
    })
  }

  xml.resources.$ = { ...xml.resources.$, ...TOOLS_XMLNS }
  await XML.writeXMLAsync({ path: file, xml })
}

module.exports = function withAndroidSystemBars(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const androidProjectRoot = config.modRequest.platformProjectRoot
      const appThemeParent = await getBaseAppThemeParent(androidProjectRoot)

      for (const target of SYSTEM_BAR_STYLE_DIRS) {
        await ensureSystemBarItemStyles(androidProjectRoot, { ...target, appThemeParent })
      }

      return config
    },
  ])
}
