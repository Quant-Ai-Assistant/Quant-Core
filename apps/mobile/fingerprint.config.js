/**
 * Over-the-air updates apply only to a build with the same native code. Every release stamps its
 * own version and versionCode, which do not change native code, so they stay out of the
 * fingerprint; otherwise no update built from main could ever match an installed APK.
 * @type {import('expo/fingerprint').Config}
 */
module.exports = {
  sourceSkips: ["ExpoConfigVersions", "ExpoConfigRuntimeVersionIfString"],
};
