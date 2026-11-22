package __PACKAGE__;

import android.app.Activity;
import android.app.AppOpsManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;
import android.util.Rational;
import android.webkit.WebView;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Picture-in-picture for a running picture (a screen, a camera, a watch together video): the app's whole window shrinks to
 * the small floating one Android keeps on top of everything, and the page (src/lib/android-pip.ts) shows only the picture in
 * it. The WebView has no picture-in-picture of its own for a video, which is why it is the activity that goes.
 *
 * Armed (the page has a picture on screen), leaving the app enters it by itself: Android 12+ does that from the params
 * (autoEnter), older ones from MainActivity.onUserLeaveHint. The button enters it at once (enter).
 *
 * Android has no pop-up that asks for this permission (as it does for the camera): "Picture-in-picture" is a switch on a
 * settings page of its own, which some makers (Xiaomi, Realme, ...) leave off for every app. So when the button is pressed
 * and the switch is off, a dialog of ours explains it and opens that page; coming back with it on, the small window opens
 * by itself, as the button asked.
 *
 * MainActivity forwards two things here (mobile/android/apply.mjs adds them): onUserLeaveHint and
 * onPictureInPictureModeChanged. The page hears the second as the "pipChanged" event.
 */
@CapacitorPlugin(name = "LibertadPip")
public class LibertadPipPlugin extends Plugin {

    private static LibertadPipPlugin instance;
    private static boolean armed = false;
    private static boolean active = false;
    private static int ratioW = 16;
    private static int ratioH = 9;
    // The button was pressed with the permission off, the settings page was opened: coming back, carry on
    private static long waitingSince = 0;
    private static final String TAG = "LibertadPip";
    private static final long WAIT_MS = 5 * 60 * 1000;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    private static boolean supported(Activity activity) {
        return activity != null
            && Build.VERSION.SDK_INT >= 26
            && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    // Android takes ratios between 1:2.39 and 2.39:1 only
    private static void setRatio(int w, int h) {
        if (w <= 0 || h <= 0) { w = 16; h = 9; }
        double r = (double) w / h;
        if (r > 2.39) { w = 239; h = 100; }
        else if (r < 1 / 2.39) { w = 100; h = 239; }
        ratioW = w;
        ratioH = h;
    }

    private static PictureInPictureParams params() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(ratioW, ratioH));
        if (Build.VERSION.SDK_INT >= 31) {
            // Home, or the recents gesture, goes straight to the small window while a picture is on screen
            b.setAutoEnterEnabled(armed);
            b.setSeamlessResizeEnabled(false);
        }
        return b.build();
    }

    // The "Picture-in-picture" switch of this app (Settings, Apps, Special app access). Unknown counts as on.
    @SuppressWarnings("deprecation")
    private static boolean allowed(Activity activity) {
        try {
            AppOpsManager ops = (AppOpsManager) activity.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return true;
            int mode = ops.checkOpNoThrow("android:picture_in_picture", Process.myUid(), activity.getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_DEFAULT;
        } catch (RuntimeException e) {
            return true;
        }
    }

    // null when the small window opened, else why not (kept short: the page shows it)
    private static String enterNow(Activity activity) {
        if (!supported(activity)) return "This phone does not have picture-in-picture.";
        if (activity.isInPictureInPictureMode()) return null;
        try {
            if (activity.enterPictureInPictureMode(params())) return null;
            Log.w(TAG, "enterPictureInPictureMode returned false");
            return "Android did not open it (it refused the request).";
        } catch (RuntimeException e) {
            // Typically: the activity does not declare support in the manifest, or is not in the foreground
            Log.w(TAG, "enterPictureInPictureMode failed", e);
            return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        }
    }

    // The permission cannot be asked for with a system pop-up (there is none for this); this asks, and takes the person to
    // the page where it is switched on
    private static void askPermission(final Activity activity) {
        final String pkg = activity.getPackageName();
        try {
            new AlertDialog.Builder(activity)
                .setTitle("Allow picture-in-picture")
                .setMessage("To keep a video on top of your other apps, Libertad needs the \u201cPicture-in-picture\u201d permission. "
                    + "Android has no pop-up for it, so it is a switch on its own page: turn it on for Libertad, then come back.")
                .setPositiveButton("Open the page", (dialog, which) -> {
                    waitingSince = System.currentTimeMillis();
                    openPermissionPage(activity, pkg);
                })
                .setNegativeButton("Not now", null)
                .show();
        } catch (RuntimeException e) {
            // A dialog this window cannot show (its theme): go to the page at once
            Log.w(TAG, "permission dialog failed", e);
            waitingSince = System.currentTimeMillis();
            openPermissionPage(activity, pkg);
        }
    }

    private static void openPermissionPage(Activity activity, String pkg) {
        Intent[] tries = new Intent[] {
            new Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS", Uri.parse("package:" + pkg)),
            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))
        };
        for (Intent intent : tries) {
            try {
                activity.startActivity(intent);
                return;
            } catch (RuntimeException e) {
                // This phone has no such page: the next one
            }
        }
    }

    /** The page says whether a picture is on screen (enabled) and how wide it is, so leaving the app can take it along. */
    @PluginMethod
    public void arm(final PluginCall call) {
        final Activity activity = getActivity();
        armed = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        setRatio(call.getInt("width", 16), call.getInt("height", 9));
        if (!supported(activity)) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 26) activity.setPictureInPictureParams(params());
                } catch (RuntimeException e) {
                    // Not now: the next arm sets it again
                }
                call.resolve();
            }
        });
    }

    /**
     * The button: into the small window now. Answers { supported, entered, reason?, message?, asked? }: reason is
     * "permission" (the switch is off: the dialog was shown, and the window opens by itself when it is turned on) or
     * "failed" (message says why).
     */
    @PluginMethod
    public void enter(final PluginCall call) {
        final Activity activity = getActivity();
        setRatio(call.getInt("width", 16), call.getInt("height", 9));
        if (activity == null) {
            call.reject("No window");
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                JSObject result = new JSObject();
                boolean ok = supported(activity);
                result.put("supported", ok);
                result.put("entered", false);
                if (!ok) {
                    result.put("reason", "failed");
                    result.put("message", "This phone does not have picture-in-picture.");
                } else {
                    // Tried first even when the switch reads as off: some makers (Xiaomi / HyperOS among them) report it wrongly,
                    // and Android itself is the one that knows. Only when it refuses, and the switch does read as off, is the
                    // person asked.
                    boolean looksOff = !allowed(activity);
                    String why = enterNow(activity);
                    result.put("entered", why == null);
                    if (why != null) {
                        if (looksOff) {
                            result.put("reason", "permission");
                            result.put("asked", true);
                            askPermission(activity);
                        } else {
                            result.put("reason", "failed");
                            result.put("message", why);
                        }
                    }
                }
                call.resolve(result);
            }
        });
    }

    // Back from the settings page: with the switch on now, the button's request goes through
    @Override
    protected void handleOnResume() {
        final Activity activity = getActivity();
        if (waitingSince == 0 || activity == null) return;
        boolean fresh = System.currentTimeMillis() - waitingSince < WAIT_MS;
        waitingSince = 0;
        if (!fresh || !allowed(activity)) return;
        activity.getWindow().getDecorView().postDelayed(new Runnable() {
            @Override
            public void run() {
                enterNow(activity);
            }
        }, 350);
    }

    /** The picture is gone while the small window is up: nothing is left to show in it, so it goes. */
    @PluginMethod
    public void exit(final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (activity.isInPictureInPictureMode()) activity.moveTaskToBack(true);
                } catch (RuntimeException e) {
                    // Already gone
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", supported(getActivity()));
        result.put("allowed", getActivity() == null || allowed(getActivity()));
        result.put("active", active);
        call.resolve(result);
    }

    // ---- from MainActivity ----

    /** MainActivity.onUserLeaveHint: Android 12+ has entered by itself already (autoEnter) */
    public static void userLeaveHint(Activity activity) {
        if (armed && Build.VERSION.SDK_INT < 31) enterNow(activity);  // the answer is not needed: nobody pressed anything
    }

    /** MainActivity.onPictureInPictureModeChanged */
    public static void modeChanged(boolean inPip, Configuration config) {
        active = inPip;
        final LibertadPipPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("active", inPip);
        plugin.notifyListeners("pipChanged", data);
        if (inPip) plugin.keepRunning();
    }

    // Before Android 10 an activity in the small window is paused, and a paused WebView can stop its timers and its
    // video; it stays visible, so it is told to carry on
    private void keepRunning() {
        final WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view == null) return;
        Runnable resume = new Runnable() {
            @Override
            public void run() {
                if (!active) return;
                view.onResume();
                view.resumeTimers();
            }
        };
        view.post(resume);
        view.postDelayed(resume, 400);
    }
}
