package dev.f0ck.Libertad;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Process;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Captures the screen (MediaProjection) into an H.264 encoder (MediaCodec) and hands every encoded frame to the plugin.
 *
 * Android 14+ wants the foreground service of type mediaProjection to be running BEFORE the projection is created, so
 * onStartCommand calls startForeground first and only then getMediaProjection. A projection can be used once: sharing
 * again asks the person again.
 *
 * The encoder repeats the last frame every 500 ms when the screen does not change, so the viewers' picture never
 * freezes and a new viewer is never more than 2 s from a keyframe. SPS/PPS (the codec config) is put in front of every
 * keyframe, which is what the page's WebCodecs decoder expects (Annex B, no description).
 */
public class LibertadCaptureService extends Service {
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_DATA = "data";
    static final String EXTRA_WIDTH = "width";
    static final String EXTRA_HEIGHT = "height";
    static final String EXTRA_FPS = "fps";
    static final String EXTRA_BITRATE = "bitrate";
    static final String EXTRA_AUDIO = "audio";
    static final String ACTION_STOP = "stop";
    private static final String CHANNEL = "libertad_capture";
    private static final int NOTIFICATION_ID = 7302;

    interface Listener {
        void onStarted(int width, int height, boolean audio);
        void onAudio(byte[] pcm);
        void onFrame(byte[] data, boolean key, long timestampUs);
        void onFailed(String message);
        void onStopped();
    }

    // Set by the plugin before the service starts. One capture at a time.
    static volatile Listener listener;

    private HandlerThread thread;
    private Handler handler;
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec encoder;
    private Surface surface;
    private byte[] config;
    private boolean running;
    // What was asked for, kept so a rotation can build the encoder again
    private int boxW, boxH, fps, bitrate, dpi, width, height;
    private AudioRecord recorder;
    private Thread audioThread;
    private volatile boolean audioOn;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // From the notification's button the page is told; from the page's own stop() it already knows
            finish(!intent.getBooleanExtra("silent", false));
            return START_NOT_STICKY;
        }
        if (intent == null || running) return START_NOT_STICKY;
        startForegroundNow();
        try {
            begin(intent);
        } catch (Exception e) {
            Listener l = listener;
            running = false;
            release();
            stopForegroundCompat();
            stopSelf();
            if (l != null) l.onFailed("Could not start screen capture: " + e.getMessage());
        }
        return START_NOT_STICKY;
    }

    private void startForegroundNow() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        }
        Intent stop = new Intent(this, LibertadCaptureService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("Libertad").setContentText("Sharing your screen").setSmallIcon(android.R.drawable.ic_menu_view).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop sharing", stopIntent).build());
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @SuppressWarnings("deprecation")
    private void begin(Intent intent) throws IOException {
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        int fps = Math.max(5, Math.min(60, intent.getIntExtra(EXTRA_FPS, 30)));
        int bitrate = Math.max(300000, intent.getIntExtra(EXTRA_BITRATE, 3000000));

        boxW = intent.getIntExtra(EXTRA_WIDTH, 1280);
        boxH = intent.getIntExtra(EXTRA_HEIGHT, 720);
        this.fps = fps;
        this.bitrate = bitrate;
        DisplayMetrics m = metrics();
        dpi = m.densityDpi;
        int[] size = fit(m);

        thread = new HandlerThread("libertad-capture");
        thread.start();
        handler = new Handler(thread.getLooper());
        makeEncoder(size[0], size[1]);

        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(resultCode, data);
        // Required from Android 14, harmless before: tells us when the person or the system ends the projection
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() { finish(true); }
        }, handler);
        display = projection.createVirtualDisplay("Libertad", width, height, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, handler);
        running = true;
        boolean audio = intent.getBooleanExtra(EXTRA_AUDIO, false) && startAudio();
        Listener l = listener;
        if (l != null) l.onStarted(width, height, audio);
    }

    private DisplayMetrics metrics() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        return m;
    }

    // The wished size is a landscape box; turn it the way the screen is, keep the screen's shape, never enlarge.
    // H.264 encoders want multiples of 16 (some only of 2): round down to 16, at least 16.
    private int[] fit(DisplayMetrics m) {
        int bw = boxW, bh = boxH;
        if (m.heightPixels > m.widthPixels) { int t = bw; bw = bh; bh = t; }
        double scale = Math.min(1.0, Math.min((double) bw / m.widthPixels, (double) bh / m.heightPixels));
        return new int[] {
            Math.max(16, ((int) Math.round(m.widthPixels * scale)) / 16 * 16),
            Math.max(16, ((int) Math.round(m.heightPixels * scale)) / 16 * 16)
        };
    }

    // A new H.264 encoder of this size; `encoder` and `surface` point at it afterwards. Output of an encoder that is no
    // longer `encoder` (the one before a rotation) is dropped.
    private void makeEncoder(int w, int h) throws IOException {
        width = w;
        height = h;
        config = null;
        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 500000L);
        if (Build.VERSION.SDK_INT >= 23) format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        MediaCodec codecNew = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        codecNew.setCallback(new EncoderCallback(), handler);
        codecNew.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        surface = codecNew.createInputSurface();
        encoder = codecNew;
        codecNew.start();
    }

    private class EncoderCallback extends MediaCodec.Callback {
        @Override
        public void onInputBufferAvailable(MediaCodec codec, int index) { }

        @Override
        public void onOutputBufferAvailable(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
            try {
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (codec == encoder && buffer != null && info.size > 0) {
                    byte[] bytes = new byte[info.size];
                    buffer.position(info.offset);
                    buffer.get(bytes);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        config = bytes;
                    } else {
                        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        byte[] c = config;
                        if (key && c != null) {
                            byte[] joined = new byte[c.length + bytes.length];
                            System.arraycopy(c, 0, joined, 0, c.length);
                            System.arraycopy(bytes, 0, joined, c.length, bytes.length);
                            bytes = joined;
                        }
                        Listener l = listener;
                        if (l != null && running) l.onFrame(bytes, key, info.presentationTimeUs);
                    }
                }
            } finally {
                try { codec.releaseOutputBuffer(index, false); } catch (IllegalStateException ignored) { }
            }
        }

        @Override
        public void onError(MediaCodec codec, MediaCodec.CodecException e) {
            if (codec == encoder) finish(true);
        }

        @Override
        public void onOutputFormatChanged(MediaCodec codec, MediaFormat newFormat) { }
    }

    // Turning the phone changes the screen's shape: a new encoder of the new size takes over the virtual display, and
    // its first keyframe carries the new SPS, which tells the page's decoder to start again.
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        Handler h = handler;
        if (h != null) h.post(this::resizeForRotation);
    }

    private void resizeForRotation() {
        if (!running || display == null) return;
        DisplayMetrics m = metrics();
        int[] size = fit(m);
        if (size[0] == width && size[1] == height) return;
        MediaCodec old = encoder;
        Surface oldSurface = surface;
        try {
            makeEncoder(size[0], size[1]);
            display.resize(size[0], size[1], m.densityDpi);
            display.setSurface(surface);
        } catch (IOException | RuntimeException e) {
            finish(true);
            return;
        }
        try { old.stop(); old.release(); } catch (RuntimeException ignored) { }
        if (oldSurface != null) oldSurface.release();
    }

    // Sound of the phone (media, games), without Libertad's own audio so a watched share is not sent back. Android 10+, RECORD_AUDIO
    // needed, and apps can opt out of being captured. 48 kHz stereo 16-bit, 20 ms per chunk.
    private boolean startAudio() {
        if (Build.VERSION.SDK_INT < 29 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        try {
            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .excludeUid(Process.myUid())
                .build();
            AudioFormat af = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
            final int chunk = 48000 / 50 * 4;
            int min = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord.Builder().setAudioPlaybackCaptureConfig(cfg).setAudioFormat(af).setBufferSizeInBytes(Math.max(min, chunk * 8)).build();
            recorder.startRecording();
            audioOn = true;
            final AudioRecord rec = recorder;
            audioThread = new Thread(() -> {
                byte[] buf = new byte[chunk];
                while (audioOn) {
                    int n = rec.read(buf, 0, chunk);
                    if (n <= 0) { if (n < 0) break; continue; }
                    Listener l = listener;
                    if (l != null) l.onAudio(n == chunk ? buf.clone() : java.util.Arrays.copyOf(buf, n));
                }
            }, "libertad-capture-audio");
            audioThread.start();
            return true;
        } catch (RuntimeException e) {
            audioOn = false;
            if (recorder != null) { try { recorder.release(); } catch (RuntimeException ignored) { } recorder = null; }
            return false;
        }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    private void release() {
        audioOn = false;
        if (recorder != null) {
            try { recorder.stop(); } catch (RuntimeException ignored) { }
            try { recorder.release(); } catch (RuntimeException ignored) { }
            recorder = null;
        }
        audioThread = null;
        try { if (display != null) display.release(); } catch (RuntimeException ignored) { }
        display = null;
        try { if (projection != null) projection.stop(); } catch (RuntimeException ignored) { }
        projection = null;
        try { if (encoder != null) { encoder.stop(); encoder.release(); } } catch (RuntimeException ignored) { }
        encoder = null;
        if (surface != null) surface.release();
        surface = null;
        if (thread != null) thread.quitSafely();
        thread = null;
        config = null;
    }

    private void finish(boolean tellPage) {
        boolean was = running;
        running = false;
        release();
        stopForegroundCompat();
        stopSelf();
        Listener l = listener;
        if (was && tellPage && l != null) l.onStopped();
    }

    @Override
    public void onDestroy() {
        running = false;
        release();
        super.onDestroy();
    }
}
