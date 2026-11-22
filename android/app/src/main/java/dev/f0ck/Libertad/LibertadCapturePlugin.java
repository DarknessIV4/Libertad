package dev.f0ck.Libertad;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Screen sharing out (see src/lib/android-capture.ts): Android's WebView has no getDisplayMedia, so the page asks this
 * plugin. start() shows the system's "Start recording or casting?" dialog; on OK, LibertadCaptureService encodes the screen
 * to H.264 and every frame comes back as a "frame" event (base64, Annex B). "stopped" says it ended on this side.
 *
 * The page never sees the permission token; the service takes it straight from the activity result.
 */
@CapacitorPlugin(
    name = "LibertadCapture",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class LibertadCapturePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Sound of the phone needs RECORD_AUDIO: ask first (Android 10+); a refusal only means no sound
        if (call.getBoolean("audio", false) && android.os.Build.VERSION.SDK_INT >= 29 && getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
        } else {
            askProjection(call);
        }
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        askProjection(call);
    }

    private void askProjection(PluginCall call) {
        MediaProjectionManager manager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("Screen capture is not available on this device");
            return;
        }
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onProjection");
    }

    @ActivityCallback
    private void onProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Permission denied");
            return;
        }
        LibertadCaptureService.listener = new LibertadCaptureService.Listener() {
            @Override
            public void onStarted(int width, int height, boolean audio) {
                JSObject r = new JSObject();
                r.put("width", width);
                r.put("height", height);
                r.put("audio", audio);
                call.resolve(r);
            }

            @Override
            public void onFrame(byte[] data, boolean key, long timestampUs) {
                JSObject e = new JSObject();
                e.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                e.put("key", key);
                e.put("ts", timestampUs);
                notifyListeners("frame", e);
            }

            @Override
            public void onAudio(byte[] pcm) {
                JSObject e = new JSObject();
                e.put("data", Base64.encodeToString(pcm, Base64.NO_WRAP));
                notifyListeners("audio", e);
            }

            @Override
            public void onFailed(String message) {
                call.reject(message);
            }

            @Override
            public void onStopped() {
                notifyListeners("stopped", new JSObject());
            }
        };
        Intent intent = new Intent(getContext(), LibertadCaptureService.class)
            .putExtra(LibertadCaptureService.EXTRA_RESULT_CODE, result.getResultCode())
            .putExtra(LibertadCaptureService.EXTRA_DATA, result.getData())
            .putExtra(LibertadCaptureService.EXTRA_WIDTH, call.getInt("width", 1280))
            .putExtra(LibertadCaptureService.EXTRA_HEIGHT, call.getInt("height", 720))
            .putExtra(LibertadCaptureService.EXTRA_AUDIO, call.getBoolean("audio", false))
            .putExtra(LibertadCaptureService.EXTRA_FPS, call.getInt("fps", 30))
            .putExtra(LibertadCaptureService.EXTRA_BITRATE, call.getInt("bitrate", 3000000));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (RuntimeException e) {
            call.reject("Could not start screen capture: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().startService(new Intent(getContext(), LibertadCaptureService.class).setAction(LibertadCaptureService.ACTION_STOP).putExtra("silent", true));
        call.resolve();
    }
}
