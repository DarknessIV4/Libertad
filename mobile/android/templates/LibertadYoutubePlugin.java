package __PACKAGE__;

import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Cleans YouTube's own interface out of the embedded player, the way the desktop app does: the pause / play icon that
 * flashes in the middle (the "bezel"), the dark top and bottom gradients, the thin progress line, the title bar,
 * suggestions, end screen and so on. The app draws its own controls over the frame (YouTubePlayer.svelte).
 *
 * The player is a cross-origin iframe, so the page cannot style it. A document-start script, registered for the
 * YouTube origins only, runs inside every frame loaded from them (the WebView feature DOCUMENT_START_SCRIPT, Android
 * System WebView 85+) and adds the style sheet before the player draws anything. Nothing else is touched.
 */
@CapacitorPlugin(name = "LibertadYoutube")
public class LibertadYoutubePlugin extends Plugin {

    // Everything in the YouTube frame goes except the video, what holds the video, the captions (the app's own captions
    // button drives them), error messages and ads. No class names of YouTube's overlays are needed (pause icon, scrim,
    // progress line, title, suggestions, mobile touch layer), so it holds wherever YouTube puts them.
    private static final String KEEP = ":not(video):not(:has(video))"
        + ":not(.ytp-caption-window-container):not(.ytp-caption-window-container *)"
        + ":not(.ytp-error):not(.ytp-error *):not(.video-ads):not(.video-ads *)"
        + ":not(.ytp-cued-thumbnail-overlay):not(.ytp-cued-thumbnail-overlay *)";
    private static final String HIDE = "{display:none !important;visibility:hidden !important;opacity:0 !important;"
        + "background:none !important;box-shadow:none !important;}";
    private static final String CSS =
        "body *" + KEEP + HIDE
        + ".ytp-large-play-button,.ytp-bezel,.ytp-spinner,.ytp-gradient-top,.ytp-gradient-bottom,.ytp-pause-overlay"
        + HIDE
        // Wrappers that hold the video keep no shade, line or border of their own
        + ".html5-video-player,.html5-video-container,.html5-video-player:before,.html5-video-player:after"
        + "{background-image:none !important;box-shadow:none !important;outline:none !important;border:0 !important;}"
        + "*{-webkit-tap-highlight-color:transparent !important;}";

    private static final String SCRIPT =
        "(function(){try{if(window.__libertadYt)return;window.__libertadYt=1;"
        + "var css=" + quote(CSS) + ";var sheet=null;"
        // A constructed style sheet is not blocked by the page's content security policy
        + "try{sheet=new CSSStyleSheet();sheet.replaceSync(css);}catch(e){sheet=null;}"
        + "function add(){try{"
        + "if(sheet){if(document.adoptedStyleSheets.indexOf(sheet)<0)document.adoptedStyleSheets=[].concat(Array.prototype.slice.call(document.adoptedStyleSheets),[sheet]);return true;}"
        + "var p=document.head||document.documentElement;if(!p)return false;"
        + "if(document.getElementById('libertad-yt-clean'))return true;"
        + "var s=document.createElement('style');s.id='libertad-yt-clean';s.textContent=css;p.appendChild(s);return true;"
        + "}catch(e){return false;}}"
        + "add();"
        // The app makes the frame taller than the picture and clips the extra, and YouTube anchors the captions to the
        // frame, so they would sit at or past the clipped edge. Pin the caption layer to the video's own rectangle.
        + "function fit(){try{var v=document.querySelector('video'),c=document.querySelector('.ytp-caption-window-container');"
        + "if(!v||!c||!c.parentElement)return;var r=v.getBoundingClientRect();if(r.width<10||r.height<10)return;"
        + "var q=c.parentElement.getBoundingClientRect(),st=c.style;"
        + "st.setProperty('position','absolute','important');st.setProperty('margin','0','important');"
        + "st.setProperty('transform','none','important');st.setProperty('right','auto','important');st.setProperty('bottom','auto','important');"
        + "st.setProperty('left',(r.left-q.left)+'px','important');st.setProperty('top',(r.top-q.top)+'px','important');"
        + "st.setProperty('width',r.width+'px','important');st.setProperty('height',r.height+'px','important');}catch(e){}}"
        + "setInterval(fit,200);window.addEventListener('resize',fit);"
        + "var t=setInterval(add,500);setTimeout(function(){clearInterval(t);setInterval(add,3000);},10000);"
        + "document.addEventListener('DOMContentLoaded',add);"
        + "console.log('[libertad-yt] cleaning style added in '+location.origin);"
        + "}catch(e){}})();";

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Override
    public void load() {
        try {
            WebView view = getBridge().getWebView();
            if (view != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                Set<String> origins = new HashSet<>(Arrays.asList(
                    "https://www.youtube-nocookie.com", "https://www.youtube.com"));
                WebViewCompat.addDocumentStartJavaScript(view, SCRIPT, origins);
                Log.i("LibertadYoutube", "YouTube frame clean-up script registered");
            } else {
                Log.w("LibertadYoutube", "This WebView cannot run scripts in frames (DOCUMENT_START_SCRIPT): update Android System WebView");
            }
        } catch (Throwable t) {
            // An old WebView: the player just keeps YouTube's own overlays
            Log.w("LibertadYoutube", "Could not register the clean-up script", t);
        }
    }
}
