package dev.f0ck.Libertad;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LibertadServicePlugin.class);
        registerPlugin(LibertadYoutubePlugin.class);
        registerPlugin(LibertadPipPlugin.class);
        registerPlugin(LibertadCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        LibertadPipPlugin.userLeaveHint(this);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        LibertadPipPlugin.modeChanged(isInPictureInPictureMode, newConfig);
    }
}
