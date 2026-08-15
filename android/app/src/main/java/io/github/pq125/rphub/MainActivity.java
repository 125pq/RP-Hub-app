package io.github.pq125.rphub;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private AppUpdateManager appUpdateManager;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFilePlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        super.onCreate(savedInstanceState);
        installWebViewDownloadListener();
        appUpdateManager = new AppUpdateManager(this);
        if (savedInstanceState == null) appUpdateManager.checkOnColdStart();
    }

    /**
     * Capacitor's WebView has no {@link android.webkit.DownloadListener} by default, so any
     * {@code <a download>} click or {@code Content-Disposition: attachment} navigation inside an
     * embedded page (e.g. the 万相广场 card download) silently does nothing. Hand those downloads
     * to the system {@link DownloadManager} and give the user feedback via a toast.
     */
    private void installWebViewDownloadListener() {
        WebView webView = getBridge().getWebView();
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme();
                if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                    // blob:/data: downloads cannot be handed to DownloadManager; ignore them.
                    return;
                }
                DownloadManager.Request request = new DownloadManager.Request(uri);
                if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(this, "下载已开始", Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, "下载失败，请重试", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (appUpdateManager != null) appUpdateManager.onActivityResult(requestCode);
    }

    @Override
    public void onDestroy() {
        if (appUpdateManager != null) appUpdateManager.destroy();
        super.onDestroy();
    }
}
