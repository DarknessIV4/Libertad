import type { CapacitorConfig } from '@capacitor/cli';

// The Android app: the page in a Capacitor WebView, plus the Mumble backend in Node.js for Mobile Apps (nodejs-mobile),
// run by the capacitor-nodejs plugin. `npm run build:android` writes both into dist-android.
const config: CapacitorConfig = {
  appId: 'dev.f0ck.Libertad',
  appName: 'Libertad',
  webDir: 'dist-android',
  plugins: {
    CapacitorNodeJS: {
      // The Node project is <webDir>/nodejs (mobile/scripts/build-node.mjs puts the bundled backend there)
      nodeDir: 'nodejs',
      // Starts with the app. The page does not rely on that: it says hello until the backend answers.
      startMode: 'auto'
    }
  }
};

export default config;
