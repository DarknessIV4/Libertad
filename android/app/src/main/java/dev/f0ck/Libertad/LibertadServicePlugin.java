package dev.f0ck.Libertad;

import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.provider.Settings;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The page's handle on LibertadForegroundService (see src/lib/android-service.ts): start it when a Mumble server is
 * connected, stop it when the last one closes, and move the audio between the loudspeaker and the earpiece.
 *
 * Starting asks for the microphone first (it decides the service type, and the page's getUserMedia needs it anyway), then
 * for notifications on Android 13+. Neither answer stops the service from starting: with no microphone it listens only,
 * and with no notification permission the notification is hidden from the shade but the service still runs.
 */
@CapacitorPlugin(
    name = "LibertadService",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class LibertadServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
        } else {
            afterMicrophone(call);
        }
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
        } else {
            begin(call);
        }
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        begin(call);
    }

    // Also what updates the notification text: starting a running service just posts it again
    private void begin(PluginCall call) {
        boolean mic = getPermissionState("microphone") == PermissionState.GRANTED;
        Intent intent = new Intent(getContext(), LibertadForegroundService.class)
            .putExtra(LibertadForegroundService.EXTRA_TITLE, call.getString("title", "Libertad"))
            .putExtra(LibertadForegroundService.EXTRA_TEXT, call.getString("text", "Connected"))
            .putExtra(LibertadForegroundService.EXTRA_MIC, mic)
            .putExtra(LibertadForegroundService.EXTRA_SPEAKER, call.getBoolean("speaker", true));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (RuntimeException e) {
            call.reject("Could not start the connection service: " + e.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("microphone", mic);
        call.resolve(result);
    }

    // A camera is open (or closed) in the page: the running service gets (or loses) the camera type, which is what lets
    // Android 11+ keep the camera going when the app is in the background. Nothing happens when no server is connected.
    @PluginMethod
    public void setCamera(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        if (!LibertadForegroundService.running) {
            call.resolve();
            return;
        }
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), LibertadForegroundService.class)
                .putExtra(LibertadForegroundService.EXTRA_CAMERA, on));
        } catch (RuntimeException e) {
            // Refused (the app is not visible): the camera works in the foreground as before
        }
        call.resolve();
    }

    // Opens one of Android's own settings pages for this app: "battery" (the list where an app can be set to unrestricted, which
    // keeps the connection alive on phones that kill background apps), "notifications", or "app" (permissions and everything else).
    //
    // Each maker hides these pages somewhere else, so there is a short list of tries per page, the phone's own first, and the
    // app's details page (every Android has it) last. A try that this phone has no page for throws, and the next one is used.
    @PluginMethod
    public void openSettings(PluginCall call) {
        String what = call.getString("what", "app");
        String pkg = getContext().getPackageName();
        List<Intent> tries = new ArrayList<>();
        if ("battery".equals(what)) {
            String maker = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(Locale.ROOT);
            if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
                // MIUI / HyperOS: the "Battery saver" page of this app, where "No restrictions" is chosen
                tries.add(new Intent().setComponent(new ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                    .putExtra("package_name", pkg).putExtra("package_label", appLabel()));
            }
            tries.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } else if ("notifications".equals(what)) {
            if (Build.VERSION.SDK_INT >= 26) {
                tries.add(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg));
            }
        }
        tries.add(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)));

        String last = "";
        for (Intent intent : tries) {
            try {
                startPage(intent);
                JSObject result = new JSObject();
                result.put("page", intent.getAction() != null ? intent.getAction() : String.valueOf(intent.getComponent()));
                call.resolve(result);
                return;
            } catch (RuntimeException e) {
                // This phone has no such page (or will not open it for an app): the next one
                last = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            }
        }
        call.reject("Could not open the settings: " + last);
    }

    private void startPage(Intent intent) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.startActivity(intent);
        } else {
            getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    private String appLabel() {
        try {
            return String.valueOf(getContext().getPackageManager().getApplicationLabel(getContext().getApplicationInfo()));
        } catch (RuntimeException e) {
            return "Libertad";
        }
    }

    // ---- Full screen ----
    //
    // Full screen for a picture: the status bar (clock, battery, notifications) and the navigation bar hidden (a swipe from the
    // edge brings them back for a moment), the picture drawn over the notch / camera hole too, and the phone turned to landscape
    // when the picture is wide. Off puts all of it back.
    //
    // Why hiding the bars is not enough (Capacitor 8, Android 15+ and the phone makers' skins):
    //   - Capacitor's SystemBars plugin pads the WHOLE window by the bars and by the display cutout, whatever the bars are doing.
    //     Hidden bars leave the cutout's height as a black strip at the top (the left side in landscape). While full screen is on,
    //     that padding is taken away again (see keepFlat) and given back when it ends, by asking for the insets once more, so
    //     Capacitor's own code puts it back exactly as it was.
    //   - AppCompat's content frame pads itself as well: same treatment.
    //   - The cutout is only drawn over when the window asks for it (layoutInDisplayCutoutMode), in both orientations.
    //   - Some skins bring the bars back after the turn to landscape, a dialog or the notification shade: it is hidden again when
    //     the window gets the focus back, when the screen turns and when the app is resumed.
    //   - Some skins ignore all of that: the older flags are used when, after a look, the bar is still there or the picture
    //     does not start at the corner of the screen.
    private boolean immersiveOn = false;
    private boolean legacyUsed = false;
    private ViewTreeObserver.OnWindowFocusChangeListener immersiveFocus = null;

    // Is the status bar (clock, battery, notifications) showing right now?
    private static boolean statusBarVisible(View decor) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        return insets != null && insets.isVisible(WindowInsetsCompat.Type.statusBars());
    }

    private View appCompatRoot(Activity activity) {
        int id = activity.getResources().getIdentifier("action_bar_root", "id", activity.getPackageName());
        return id != 0 ? activity.findViewById(id) : null;
    }

    private View webView() {
        return getBridge() != null ? getBridge().getWebView() : null;
    }

    // Where the page starts on the screen: { top, left } in pixels. {0, 0}: the picture reaches the corner, notch included.
    private int[] pageCorner() {
        int[] xy = new int[] { 0, 0 };
        View web = webView();
        if (web != null && web.isAttachedToWindow()) web.getLocationOnScreen(xy);
        return new int[] { xy[1], xy[0] };
    }

    // The older way, for the phones whose makers ignore the newer one: the window's own full screen flag, the view's system UI
    // flags, and a window that may reach past the screen's edge (over the cutout).
    @SuppressWarnings("deprecation")
    private static void legacyImmersive(Activity activity, boolean on) {
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        int flags = WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        if (on) {
            window.addFlags(flags);
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            window.clearFlags(flags);
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    // While full screen: no padding around the page. Capacitor pads the window (decor view) from its own insets listener, which
    // runs first; these run after it, further down the view tree, in the same pass and before anything is laid out, and take it away.
    private void keepFlat(final Activity activity, boolean on) {
        final View decor = activity.getWindow().getDecorView();
        View root = appCompatRoot(activity);
        View web = webView();
        if (on) {
            if (root != null) {
                ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                    decor.setPadding(0, 0, 0, 0);
                    v.setPadding(0, 0, 0, 0);
                    return WindowInsetsCompat.CONSUMED;
                });
                root.setPadding(0, 0, 0, 0);
            }
            if (web != null) {
                ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
                    decor.setPadding(0, 0, 0, 0);
                    return ViewCompat.onApplyWindowInsets(v, insets);
                });
            }
            decor.setPadding(0, 0, 0, 0);
        } else {
            if (root != null) ViewCompat.setOnApplyWindowInsetsListener(root, null);
            if (web != null) ViewCompat.setOnApplyWindowInsetsListener(web, null);
        }
        // Capacitor's listener runs again and sets its padding back (off) or ours takes it away again (on)
        ViewCompat.requestApplyInsets(decor);
    }

    private void applyImmersive(Activity activity, boolean on) {
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        WindowCompat.setDecorFitsSystemWindows(window, !on);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams params = window.getAttributes();
            // ALWAYS (Android 11+) also covers the cutout when the phone is held upright; SHORT_EDGES is its older form
            int mode = !on
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
                : Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            if (params.layoutInDisplayCutoutMode != mode) {
                params.layoutInDisplayCutoutMode = mode;
                window.setAttributes(params);
            }
        }
        if (on) {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
        } else {
            controller.show(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
        }
        keepFlat(activity, on);
    }

    private JSObject immersiveResult(View decor) {
        int[] corner = pageCorner();
        JSObject result = new JSObject();
        result.put("statusBarVisible", immersiveOn && statusBarVisible(decor));
        result.put("legacy", legacyUsed);
        result.put("offsetTop", corner[0]);
        result.put("offsetLeft", corner[1]);
        return result;
    }

    // Answers { statusBarVisible, legacy, offsetTop, offsetLeft } when going to full screen: whether the status bar is still
    // showing after everything, whether the older way was needed, and how far the page starts from the corner of the screen,
    // so the page can say so instead of leaving it looking like a bug
    @PluginMethod
    public void setImmersive(final PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                final View decor = activity.getWindow().getDecorView();
                immersiveOn = on;
                applyImmersive(activity, on);
                if (!on && legacyUsed) {
                    legacyImmersive(activity, false);
                    legacyUsed = false;
                }
                if (on && immersiveFocus == null) {
                    immersiveFocus = hasFocus -> {
                        if (hasFocus && immersiveOn) applyImmersive(activity, true);
                    };
                    decor.getViewTreeObserver().addOnWindowFocusChangeListener(immersiveFocus);
                } else if (!on && immersiveFocus != null) {
                    decor.getViewTreeObserver().removeOnWindowFocusChangeListener(immersiveFocus);
                    immersiveFocus = null;
                }
                activity.setRequestedOrientation(on && landscape
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                if (!on) {
                    call.resolve();
                    return;
                }
                // The turn to landscape brings the bars back on some phones: once more when it is done
                decor.postDelayed(() -> { if (immersiveOn) applyImmersive(activity, true); }, 250);
                // Then look: still a bar, or not at the corner? The older way as well, and look again
                decor.postDelayed(() -> {
                    try {
                        int[] corner = pageCorner();
                        boolean problem = immersiveOn && (statusBarVisible(decor) || corner[0] > 0 || corner[1] > 0);
                        if (problem) {
                            legacyImmersive(activity, true);
                            legacyUsed = true;
                            applyImmersive(activity, true);
                            decor.postDelayed(() -> call.resolve(immersiveResult(decor)), 450);
                        } else {
                            call.resolve(immersiveResult(decor));
                        }
                    } catch (RuntimeException e) {
                        call.resolve();
                    }
                }, 650);
            } catch (RuntimeException e) {
                call.reject("Could not change full screen: " + e.getMessage());
            }
        });
    }

    // The system can bring the bars back when the screen turns or the app comes back from another one
    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        reassertImmersive();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        reassertImmersive();
    }

    private void reassertImmersive() {
        final Activity activity = getActivity();
        if (!immersiveOn || activity == null) return;
        final View decor = activity.getWindow().getDecorView();
        decor.postDelayed(() -> { if (immersiveOn) applyImmersive(activity, true); }, 150);
    }

    // What this phone and this install are (Settings, System): the page shows it, so a build that did not take is seen at once
    @PluginMethod
    public void diagnose(PluginCall call) {
        JSObject result = new JSObject();
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("release", Build.VERSION.RELEASE);
        result.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            result.put("installedAt", info.lastUpdateTime);
            result.put("targetSdk", info.applicationInfo.targetSdkVersion);
        } catch (Exception e) {
            // Not known: the page leaves it out
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo web = WebView.getCurrentWebViewPackage();
                if (web != null) result.put("webview", web.versionName);
            }
        } catch (RuntimeException e) {
            // Not known
        }
        try {
            Activity activity = getActivity();
            if (activity != null) {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView());
                if (insets != null && insets.getDisplayCutout() != null) {
                    result.put("cutoutTop", insets.getDisplayCutout().getSafeInsetTop());
                    result.put("cutoutSide", Math.max(insets.getDisplayCutout().getSafeInsetLeft(), insets.getDisplayCutout().getSafeInsetRight()));
                }
            }
        } catch (RuntimeException e) {
            // Not known
        }
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), LibertadForegroundService.class));
        call.resolve();
    }

    @PluginMethod
    public void setSpeakerphone(PluginCall call) {
        LibertadForegroundService.routeSpeaker(getContext(), call.getBoolean("on", true));
        call.resolve();
    }
}
