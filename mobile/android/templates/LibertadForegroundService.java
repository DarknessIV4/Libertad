package __PACKAGE__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps the app, and with it the Node.js backend (nodejs-mobile runs inside this process), alive while a Mumble
 * server is connected. Without a foreground service Android freezes a backgrounded app within minutes, which drops the
 * TLS connection and the UDP voice.
 *
 * Started and stopped from the page through LibertadServicePlugin (src/lib/android-service.ts). While it runs:
 *  - a notification says what is connected (required for a foreground service);
 *  - a partial wake lock and a Wi-Fi lock keep the CPU and the radio awake for the keepalives and voice;
 *  - audio is in communication mode, so the microphone and the speaker are set up for voice chat.
 *
 * Type: microphone when the user granted RECORD_AUDIO (it lets the microphone work in the background), otherwise
 * specialUse (listening only). Both are declared in the manifest by mobile/android/apply.mjs.
 */
public class LibertadForegroundService extends Service {
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_MIC = "mic";
    static final String EXTRA_SPEAKER = "speaker";
    // Present only when the camera starts or stops; everything else keeps its last value
    static final String EXTRA_CAMERA = "camera";
    static volatile boolean running;

    private static final String CHANNEL_ID = "libertad_connection";
    private static final int NOTIFICATION_ID = 4101;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private boolean audioSet;
    private String lastTitle = "Libertad", lastText = "Connected";
    private boolean lastMic, camera;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra(EXTRA_TITLE)) lastTitle = intent.getStringExtra(EXTRA_TITLE);
        if (intent != null && intent.hasExtra(EXTRA_TEXT)) lastText = intent.getStringExtra(EXTRA_TEXT);
        if (intent != null && intent.hasExtra(EXTRA_MIC)) lastMic = intent.getBooleanExtra(EXTRA_MIC, false);
        if (intent != null && intent.hasExtra(EXTRA_CAMERA)) camera = intent.getBooleanExtra(EXTRA_CAMERA, false);
        String title = lastTitle;
        String text = lastText;
        boolean mic = lastMic;
        boolean speaker = intent == null || intent.getBooleanExtra(EXTRA_SPEAKER, true);

        ensureChannel();
        Notification notification = buildNotification(title, text);
        try {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, foregroundType(mic, camera));
            } catch (SecurityException e) {
                try {
                    // The camera type needs CAMERA at this very moment; without it the camera stops with the app
                    camera = false;
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, foregroundType(mic, false));
                } catch (SecurityException e2) {
                    // The microphone type needs RECORD_AUDIO at this very moment (the user may have revoked it): listen only
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, foregroundType(false, false));
                }
            }
            running = true;
        } catch (RuntimeException e) {
            // Android 12+ refuses to start one from the background; nothing is held, so nothing to undo
            stopSelf();
            return START_NOT_STICKY;
        }

        acquireLocks();
        if (!audioSet) {
            audioSet = true;
            setCommunicationAudio(this, speaker);
        }
        // If Android kills the process the connections are gone with it: there is nothing to bring back
        return START_NOT_STICKY;
    }

    // Android 11+ only lets an app use the camera or microphone in the background when a running foreground service of that
    // type was started while the app was visible; the camera type is added only while a camera is open.
    private static int foregroundType(boolean mic, boolean camera) {
        int type = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            if (mic) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (camera) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        if (type == 0 && Build.VERSION.SDK_INT >= 34) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
        return type;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Connection", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Libertad is connected to a Mumble server");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String title, String text) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = launch == null ? null
            : PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            // A system icon until the app has a monochrome one (res/drawable/ic_stat_libertad)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @SuppressWarnings({"deprecation", "WakelockTimeout"})
    private void acquireLocks() {
        // Held for as long as the service runs (released in onDestroy), so no timeout
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Libertad:connection");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();

        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "Libertad:connection");
                wifiLock.setReferenceCounted(false);
            }
        }
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (audioSet) {
            audioSet = false;
            clearCommunicationAudio(this);
        }
        super.onDestroy();
    }

    // The user swiped the app away: the process is going, so stop cleanly
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ─── Audio ───────────────────────────────────────────────────────────────

    static void setCommunicationAudio(Context context, boolean speaker) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return;
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        routeSpeaker(context, speaker);
    }

    static void clearCommunicationAudio(Context context) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return;
        routeSpeaker(context, false);
        audio.setMode(AudioManager.MODE_NORMAL);
    }

    /**
     * The loudspeaker on or off. On leaves a connected headset or Bluetooth device alone: forcing the loudspeaker
     * over what the user plugged in would be wrong. Off hands routing back to the system (headset, Bluetooth, earpiece).
     */
    @SuppressWarnings("deprecation")
    static void routeSpeaker(Context context, boolean on) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return;
        try {
            boolean force = on && !hasExternalOutput(audio);
            if (Build.VERSION.SDK_INT >= 31) {
                if (force) {
                    for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
                        if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            audio.setCommunicationDevice(device);
                            return;
                        }
                    }
                } else {
                    audio.clearCommunicationDevice();
                }
            } else {
                audio.setSpeakerphoneOn(force);
            }
        } catch (RuntimeException ignored) {
            // Routing is a nicety; the call works without it
        }
    }

    private static boolean hasExternalOutput(AudioManager audio) {
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_USB_DEVICE:
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                    return true;
                default:
                    break;
            }
            if (Build.VERSION.SDK_INT >= 31 && (device.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET)) return true;
        }
        return false;
    }
}
