const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/**
 * Android settings for a self-hosted Quant:
 * - A server often runs at http://<LAN address>:<port>, and release builds block cleartext HTTP.
 *   lib/endpoint.ts still refuses plain HTTP to public hosts.
 * - The in-app update downloads the APK from GitHub and opens Android's installer.
 */
module.exports = function withQuantAndroid(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults;
    const application = manifest.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    AndroidConfig.Permissions.ensurePermission(manifest, "android.permission.REQUEST_INSTALL_PACKAGES");
    return next;
  });
};
