package io.github.pq125.rphub;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.net.URI;
import java.util.Set;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final String DOWNLOAD_TAG = "RPHubDownload";
    private static final Pattern MIME_PATTERN = Pattern.compile("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$");
    static final Set<String> SQUARE_ORIGIN_RULES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "https://rphforum.zeabur.app",
        "https://rp.zhaoyangxx.ccwu.cc"
    )));
    private static final String DOWNLOAD_BRIDGE_ASSET = "rphub-download-bridge.js";
    private AppUpdateManager appUpdateManager;
    private boolean downloadCompletionReceiverRegistered;
    private final Set<Long> appDownloadIds = Collections.synchronizedSet(new HashSet<>());

    private final WebViewListener downloadBridgePageListener = new WebViewListener() {
        @Override
        public void onPageLoaded(WebView webView) {
            installRootDownloadBridge(webView);
        }
    };

    private final BroadcastReceiver downloadCompletionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            reportDownloadCompletion(intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L));
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        NativeThemePlugin.restoreNightMode(this);
        registerPlugin(NativeFilePlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        registerPlugin(NativeThemePlugin.class);
        bridgeBuilder.addWebViewListener(downloadBridgePageListener);
        super.onCreate(savedInstanceState);
        configureDarkMode();
        WebView webView = getBridge().getWebView();
        configureWebViewCookies(webView);
        installNativeDownloadBridge(webView);
        installWebViewDownloadListener();
        registerDownloadCompletionReceiver();
        appUpdateManager = new AppUpdateManager(this);
        AttributionDialog.showIfNeeded(
            this,
            savedInstanceState == null ? appUpdateManager::checkOnColdStart : null
        );
    }

    private void configureDarkMode() {
        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.getSettings(), true);
        }
    }

    private void configureWebViewCookies(WebView webView) {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        boolean thirdPartyAccepted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
            thirdPartyAccepted = cookieManager.acceptThirdPartyCookies(webView);
        }
        Log.i(DOWNLOAD_TAG, "webview_cookie_policy accept=" + cookieManager.acceptCookie()
            + " third_party=" + thirdPartyAccepted);
    }

    private void installNativeDownloadBridge(WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(DOWNLOAD_TAG, "download_bridge_unsupported reason=document_start_script");
            return;
        }
        try {
            // The root listener is installed by the Bridge's main-frame callback registered
            // before super.onCreate. This document-start hook is only for subsequently loaded
            // square frames, and is restricted to the two configured square origins.
            String script = loadDownloadBridgeScript();
            if (script == null) return;
            WebViewCompat.addDocumentStartJavaScript(webView, script, SQUARE_ORIGIN_RULES);
            Log.i(DOWNLOAD_TAG, "download_bridge_installed feature=document_start_script origins=square");
        } catch (RuntimeException error) {
            Log.e(DOWNLOAD_TAG, "download_bridge_unsupported reason=install_failed", error);
        }
    }

    private void installRootDownloadBridge(WebView webView) {
        String script = loadDownloadBridgeScript();
        if (script == null) return;
        webView.evaluateJavascript(script, null);
        Log.i(DOWNLOAD_TAG, "download_bridge_root_installed main_frame=true");
    }

    private String loadDownloadBridgeScript() {
        try (java.io.InputStream stream = getAssets().open(DOWNLOAD_BRIDGE_ASSET)) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toString(java.nio.charset.StandardCharsets.UTF_8.name());
        } catch (java.io.IOException error) {
            Log.e(DOWNLOAD_TAG, "download_bridge_unsupported reason=asset_unavailable", error);
            return null;
        }
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
                if (!isHttpDownloadScheme(scheme)) {
                    Log.w(DOWNLOAD_TAG, "download_unsupported scheme="
                        + (scheme == null ? "<none>" : scheme.toLowerCase(Locale.ROOT))
                        + " bridge=" + (isBlobOrDataScheme(scheme) ? "native_blob" : "none"));
                    return;
                }
                DownloadManager.Request request = new DownloadManager.Request(uri);
                String effectiveUserAgent = userAgent;
                if (effectiveUserAgent == null || effectiveUserAgent.trim().isEmpty()) {
                    effectiveUserAgent = webView.getSettings().getUserAgentString();
                }
                if (effectiveUserAgent != null && !effectiveUserAgent.trim().isEmpty()) {
                    request.addRequestHeader("User-Agent", effectiveUserAgent);
                }
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null && !cookie.trim().isEmpty()) request.addRequestHeader("Cookie", cookie);
                String referer = inferDownloadReferer(webView.getUrl(), uri);
                if (referer != null) request.addRequestHeader("Referer", referer);
                String mimeType = normalizeMimeType(mimetype);
                if (mimeType != null) request.setMimeType(mimeType);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                // Without an explicit destination, DownloadManager saves to a hidden, purgeable
                // system-cache location the user can never find. Save to the public Downloads
                // folder instead, named from Content-Disposition (or the URL) via guessFileName.
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                request.setTitle(fileName);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
                long downloadId = manager.enqueue(request);
                appDownloadIds.add(downloadId);
                Log.i(DOWNLOAD_TAG, "download_enqueue id=" + downloadId
                    + " scheme=" + scheme.toLowerCase(Locale.ROOT)
                    + " mime=" + (mimeType == null ? "<none>" : mimeType)
                    + " cookie=" + (cookie != null && !cookie.trim().isEmpty())
                    + " referer=" + (referer == null ? "<none>" : "present")
                    + " ua=" + (effectiveUserAgent != null && !effectiveUserAgent.trim().isEmpty())
                    + " disposition=" + (contentDisposition != null && !contentDisposition.trim().isEmpty())
                    + " length=" + contentLength
                    + " filename=" + fileName);
                Toast.makeText(this, "下载已开始", Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Log.e(DOWNLOAD_TAG, "download_enqueue_failed reason=" + error.getClass().getSimpleName(), error);
                Toast.makeText(this, "下载失败，请重试", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void registerDownloadCompletionReceiver() {
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // DownloadManager is a system service and sends this broadcast from outside the app.
            registerReceiver(downloadCompletionReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadCompletionReceiver, filter);
        }
        downloadCompletionReceiverRegistered = true;
    }

    private void reportDownloadCompletion(long downloadId) {
        if (downloadId < 0) {
            Log.e(DOWNLOAD_TAG, "download_complete status=failed reason=missing_id");
            return;
        }
        if (!appDownloadIds.remove(downloadId)) {
            Log.d(DOWNLOAD_TAG, "download_complete_ignored id=" + downloadId + " reason=not_local_enqueue");
            return;
        }
        DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            Log.e(DOWNLOAD_TAG, "download_complete id=" + downloadId + " status=failed reason=manager_unavailable");
            return;
        }
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                Log.e(DOWNLOAD_TAG, "download_complete id=" + downloadId + " status=failed reason=record_missing");
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                Log.i(DOWNLOAD_TAG, "download_complete id=" + downloadId
                    + " status=successful");
            } else {
                Log.e(DOWNLOAD_TAG, "download_complete id=" + downloadId
                    + " status=" + downloadStatusName(status)
                    + " reason=" + downloadFailureReasonName(reason)
                    + " reason_code=" + reason);
            }
        } catch (RuntimeException error) {
            Log.e(DOWNLOAD_TAG, "download_complete id=" + downloadId + " status=failed reason=query_failed", error);
        }
    }

    static boolean isHttpDownloadScheme(String scheme) {
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    static boolean isBlobOrDataScheme(String scheme) {
        return "blob".equalsIgnoreCase(scheme) || "data".equalsIgnoreCase(scheme);
    }

    static String normalizeMimeType(String value) {
        if (value == null) return null;
        String mimeType = value.split(";", 2)[0].trim();
        return MIME_PATTERN.matcher(mimeType).matches() ? mimeType : null;
    }

    static String inferDownloadReferer(String pageUrl, Uri downloadUri) {
        return inferDownloadReferer(pageUrl, downloadUri == null ? null : downloadUri.toString());
    }

    static String inferDownloadReferer(String pageUrl, String downloadUrl) {
        String downloadHost;
        try {
            downloadHost = downloadUrl == null ? null : new URI(downloadUrl).getHost();
        } catch (Exception ignored) {
            downloadHost = null;
        }
        if (downloadHost == null || downloadHost.trim().isEmpty()) return null;
        if (pageUrl != null && !pageUrl.trim().isEmpty()) {
            try {
                URI pageUri = new URI(pageUrl);
                if (isHttpDownloadScheme(pageUri.getScheme()) && downloadHost.equalsIgnoreCase(pageUri.getHost())) {
                    return pageUri.toString();
                }
            } catch (Exception ignored) {}
        }
        if ("rphforum.zeabur.app".equalsIgnoreCase(downloadHost)
            || "rp.zhaoyangxx.ccwu.cc".equalsIgnoreCase(downloadHost)) {
            return "https://" + downloadHost + "/";
        }
        return null;
    }

    static String downloadStatusName(int status) {
        switch (status) {
            case DownloadManager.STATUS_PENDING: return "pending";
            case DownloadManager.STATUS_RUNNING: return "running";
            case DownloadManager.STATUS_PAUSED: return "paused";
            case DownloadManager.STATUS_SUCCESSFUL: return "successful";
            case DownloadManager.STATUS_FAILED: return "failed";
            default: return "unknown";
        }
    }

    static String downloadFailureReasonName(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_CANNOT_RESUME: return "cannot_resume";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "device_not_found";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS: return "file_already_exists";
            case DownloadManager.ERROR_FILE_ERROR: return "file_error";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "http_data_error";
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "insufficient_space";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "too_many_redirects";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "unhandled_http_code";
            case DownloadManager.ERROR_UNKNOWN: return "unknown";
            default: return "reason_" + reason;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (appUpdateManager != null) appUpdateManager.onActivityResult(requestCode);
    }

    @Override
    public void onDestroy() {
        if (downloadCompletionReceiverRegistered) {
            unregisterReceiver(downloadCompletionReceiver);
            downloadCompletionReceiverRegistered = false;
        }
        appDownloadIds.clear();
        if (appUpdateManager != null) appUpdateManager.destroy();
        super.onDestroy();
    }
}
