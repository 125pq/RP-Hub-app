package io.github.pq125.rphub;

import android.app.ProgressDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.FileProvider;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class AppUpdateManager {
    private static final String TAG = "RPHubUpdate";
    private static final String LATEST_RELEASE_API = "https://api.github.com/repos/125pq/RP-Hub-app/releases/latest";
    private static final String GITEE_RELEASE_API =
        "https://gitee.com/api/v5/repos/pq125pq/rp-hub-app/releases/latest";
    private static final int UNKNOWN_APPS_REQUEST = 19082;
    private static final int CONNECT_TIMEOUT_MS = 12000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final long SLOW_SOURCE_GRACE_MS = 30000L;
    private static final long MIN_DOWNLOAD_BYTES_PER_SECOND = 100L * 1024L;

    private final MainActivity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private final AtomicBoolean downloadCancelled = new AtomicBoolean(false);
    private final AtomicBoolean sourceSwitchRequested = new AtomicBoolean(false);
    private final Runnable coldStartCheck = () -> {
        if (!destroyed.get()) executor.execute(this::checkQuietly);
    };
    private AppUpdateRelease pendingInstall;
    private File pendingApk;
    private ProgressDialog progressDialog;

    AppUpdateManager(MainActivity activity) {
        this.activity = activity;
    }

    void checkOnColdStart() {
        if ((activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) return;
        activity.getWindow().getDecorView().postDelayed(coldStartCheck, 1200L);
    }

    void onActivityResult(int requestCode) {
        if (requestCode != UNKNOWN_APPS_REQUEST || pendingApk == null || pendingInstall == null) return;
        if (canInstallUnknownApps()) {
            launchInstaller(pendingApk);
        } else {
            showRetry("尚未允许此应用安装未知应用。", () -> requestInstallPermission(pendingApk, pendingInstall));
        }
    }

    void destroy() {
        activity.getWindow().getDecorView().removeCallbacks(coldStartCheck);
        downloadCancelled.set(true);
        dismissProgress();
        destroyed.set(true);
        executor.shutdownNow();
    }

    private void checkQuietly() {
        try {
            AppUpdateRelease release = fetchLatestRelease();
            if (release == null || release.versionCode <= installedVersionCode()) return;
            runOnUiThread(() -> showUpdateDialog(release));
        } catch (Exception error) {
            // Cold-start update checks are best-effort and must never interrupt normal app startup.
            Log.i(TAG, "Update check skipped: " + error.getMessage());
        }
    }

    private AppUpdateRelease fetchLatestRelease() throws IOException, JSONException {
        Exception lastError = null;
        try {
            AppUpdateRelease release = parseGiteeRelease(new JSONObject(readUtf8(GITEE_RELEASE_API, MAX_RESPONSE_BYTES)));
            if (release != null) {
                Log.i(TAG, "Update metadata source: Gitee Release");
                return release;
            }
        } catch (IOException | JSONException error) {
            lastError = error;
        }
        try {
            AppUpdateRelease release = parseGitHubRelease(new JSONObject(readUtf8(LATEST_RELEASE_API, MAX_RESPONSE_BYTES)));
            if (release != null) {
                Log.i(TAG, "Update metadata source: GitHub API fallback");
                return release;
            }
        } catch (IOException | JSONException error) {
            lastError = error;
        }
        if (lastError instanceof IOException) throw (IOException) lastError;
        throw new IOException("所有更新源均不可用", lastError);
    }

    private AppUpdateRelease parseGiteeRelease(JSONObject json) throws JSONException {
        AppUpdateRelease release = parseGitHubRelease(json);
        if (release == null) return null;
        List<String> urls = new ArrayList<>(release.apkUrls);
        String githubFallback = "https://github.com/125pq/RP-Hub-app/releases/download/"
            + json.getString("tag_name") + "/" + release.apkName;
        if (!isAllowedDownloadUrl(githubFallback)) throw new JSONException("GitHub 备用下载地址无效");
        urls.add(githubFallback);
        return new AppUpdateRelease(
            release.versionName,
            release.versionCode,
            release.notes,
            release.apkName,
            urls,
            release.apkSize,
            release.sha256
        );
    }

    private AppUpdateRelease parseGitHubRelease(JSONObject json) throws JSONException {
        if (json.optBoolean("draft") || json.optBoolean("prerelease")) return null;
        AppUpdateRelease.Version version = AppUpdateRelease.parseAndroidTag(json.optString("tag_name"));
        if (version == null) return null;

        String body = json.optString("body", "");
        String expectedName = "RP-Hub-" + version.name + "-release.apk";
        JSONArray assets = json.optJSONArray("assets");
        if (assets == null) return null;
        for (int index = 0; index < assets.length(); index++) {
            JSONObject asset = assets.optJSONObject(index);
            if (asset == null || !expectedName.equals(asset.optString("name"))) continue;
            String sha = AppUpdateRelease.shaFromDigestOrNotes(asset.optString("digest", ""), body);
            String url = asset.optString("browser_download_url", "");
            if (sha == null || !isAllowedDownloadUrl(url)) return null;
            return new AppUpdateRelease(
                version.name,
                version.code,
                body,
                expectedName,
                java.util.Collections.singletonList(url),
                asset.optLong("size", -1L),
                sha
            );
        }
        return null;
    }

    private void showUpdateDialog(AppUpdateRelease release) {
        if (!canShowUi()) return;
        TextView notes = new TextView(activity);
        int padding = dp(20);
        notes.setPadding(padding, padding / 2, padding, padding / 2);
        notes.setText(release.notes);
        notes.setTextIsSelectable(true);
        notes.setTextSize(14f);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(notes);

        new AlertDialog.Builder(activity)
            .setTitle("发现新版本 " + release.versionName)
            .setView(scroll)
            .setNegativeButton("稍后更新", null)
            .setPositiveButton("立即更新", (dialog, which) -> startDownload(release))
            .show();
    }

    private void startDownload(AppUpdateRelease release) {
        downloadCancelled.set(false);
        showProgress(release);
        executor.execute(() -> {
            File destination = new File(new File(activity.getCacheDir(), "updates"), release.apkName);
            try {
                downloadAndVerify(release, destination);
                if (downloadCancelled.get()) return;
                pendingInstall = release;
                pendingApk = destination;
                runOnUiThread(() -> {
                    dismissProgress();
                    requestInstallPermission(destination, release);
                });
            } catch (Exception error) {
                if (destination.exists()) destination.delete();
                runOnUiThread(() -> {
                    dismissProgress();
                    if (!downloadCancelled.get()) {
                        showRetry("更新下载或校验失败：" + safeMessage(error), () -> startDownload(release));
                    }
                });
            }
        });
    }

    private void downloadAndVerify(AppUpdateRelease release, File destination) throws Exception {
        Exception lastError = null;
        for (int index = 0; index < release.apkUrls.size(); index++) {
            String url = release.apkUrls.get(index);
            sourceSwitchRequested.set(false);
            publishSourceStatus(index + 1, release.apkUrls.size());
            try {
                downloadAndVerifyFromUrl(release, destination, url, index < release.apkUrls.size() - 1);
                Log.i(TAG, "Verified APK source: " + url);
                return;
            } catch (Exception error) {
                if (downloadCancelled.get()) throw error;
                lastError = error;
                Log.i(TAG, "APK source failed, trying next: " + url + " (" + error.getMessage() + ")");
            }
        }
        throw new IOException("所有 APK 下载源均失败", lastError);
    }

    private void downloadAndVerifyFromUrl(
        AppUpdateRelease release,
        File destination,
        String downloadUrl,
        boolean switchWhenSlow
    ) throws Exception {
        File parent = destination.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) throw new IOException("无法创建更新缓存目录");
        File temporary = new File(parent, destination.getName() + ".part");
        if (temporary.exists() && !temporary.delete()) throw new IOException("无法清理旧下载");

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        HttpURLConnection connection = openConnectionFollowingRedirects(downloadUrl);
        long total = connection.getContentLengthLong();
        long downloaded = 0L;
        long startedAt = android.os.SystemClock.elapsedRealtime();
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (downloadCancelled.get() || Thread.currentThread().isInterrupted()) throw new IOException("下载已取消");
                if (sourceSwitchRequested.get()) throw new IOException("用户切换下载源");
                output.write(buffer, 0, count);
                digest.update(buffer, 0, count);
                downloaded += count;
                long elapsed = android.os.SystemClock.elapsedRealtime() - startedAt;
                long bytesPerSecond = downloaded * 1000L / Math.max(1L, elapsed);
                publishProgress(downloaded, total > 0 ? total : release.apkSize, bytesPerSecond);
                if (switchWhenSlow && elapsed >= SLOW_SOURCE_GRACE_MS
                    && bytesPerSecond < MIN_DOWNLOAD_BYTES_PER_SECOND) {
                    throw new IOException("当前下载源速度过慢（" + (bytesPerSecond / 1024L) + " KB/s），正在切换");
                }
            }
            output.getFD().sync();
        } finally {
            connection.disconnect();
        }

        String actualSha = toHex(digest.digest());
        if (!actualSha.equals(release.sha256)) throw new IOException("SHA-256 不匹配");
        verifyApkIdentity(temporary, release);
        if (destination.exists() && !destination.delete()) throw new IOException("无法替换旧安装包");
        if (!temporary.renameTo(destination)) throw new IOException("无法保存已校验的安装包");
    }

    private void verifyApkIdentity(File apk, AppUpdateRelease release) throws Exception {
        PackageManager manager = activity.getPackageManager();
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (archive == null || !activity.getPackageName().equals(archive.packageName)) throw new IOException("安装包应用 ID 不匹配");
        long archiveCode = packageVersionCode(archive);
        if (archiveCode != release.versionCode || archiveCode <= packageVersionCode(installed)) {
            throw new IOException("安装包版本号不匹配");
        }
        if (!sameSigners(installed, archive)) throw new IOException("安装包签名与当前应用不一致");
    }

    private boolean sameSigners(PackageInfo first, PackageInfo second) {
        if (first.signingInfo == null || second.signingInfo == null) return false;
        Signature[] firstSigners = first.signingInfo.getApkContentsSigners();
        Signature[] secondSigners = second.signingInfo.getApkContentsSigners();
        if (firstSigners.length != secondSigners.length) return false;
        byte[][] firstBytes = signatureBytes(firstSigners);
        byte[][] secondBytes = signatureBytes(secondSigners);
        Arrays.sort(firstBytes, AppUpdateManager::compareBytes);
        Arrays.sort(secondBytes, AppUpdateManager::compareBytes);
        return Arrays.deepEquals(firstBytes, secondBytes);
    }

    private void requestInstallPermission(File apk, AppUpdateRelease release) {
        pendingApk = apk;
        pendingInstall = release;
        if (canInstallUnknownApps()) {
            launchInstaller(apk);
            return;
        }
        new AlertDialog.Builder(activity)
            .setTitle("需要安装权限")
            .setMessage("请在系统设置中允许“RP Hub”安装未知应用。返回后会继续打开系统安装器。")
            .setNegativeButton("稍后更新", null)
            .setPositiveButton("前往设置", (dialog, which) -> {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(intent, UNKNOWN_APPS_REQUEST);
            })
            .show();
    }

    private boolean canInstallUnknownApps() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.getPackageManager().canRequestPackageInstalls();
    }

    private void launchInstaller(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("RP Hub update", uri));
            activity.startActivity(intent);
        } catch (Exception error) {
            showRetry("无法打开系统安装器：" + safeMessage(error), () -> launchInstaller(apk));
        }
    }

    private void showProgress(AppUpdateRelease release) {
        if (!canShowUi()) return;
        progressDialog = new ProgressDialog(activity);
        progressDialog.setTitle("正在下载 " + release.versionName);
        progressDialog.setMessage("准备下载…");
        progressDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progressDialog.setIndeterminate(release.apkSize <= 0);
        progressDialog.setMax(100);
        progressDialog.setCancelable(false);
        progressDialog.setButton(ProgressDialog.BUTTON_NEUTRAL, "切换源", (dialog, which) -> {});
        progressDialog.setButton(ProgressDialog.BUTTON_NEGATIVE, "取消", (dialog, which) -> {});
        progressDialog.show();
        progressDialog.getButton(ProgressDialog.BUTTON_NEUTRAL).setOnClickListener(view -> sourceSwitchRequested.set(true));
        progressDialog.getButton(ProgressDialog.BUTTON_NEGATIVE).setOnClickListener(view -> {
            downloadCancelled.set(true);
            progressDialog.dismiss();
        });
    }

    private void publishProgress(long downloaded, long total, long bytesPerSecond) {
        runOnUiThread(() -> {
            if (progressDialog == null || !progressDialog.isShowing()) return;
            if (total > 0) {
                progressDialog.setIndeterminate(false);
                progressDialog.setProgress((int) Math.min(100L, downloaded * 100L / total));
                progressDialog.setMessage(formatBytes(downloaded) + " / " + formatBytes(total)
                    + " · " + formatBytes(bytesPerSecond) + "/s");
            } else {
                progressDialog.setMessage("已下载 " + formatBytes(downloaded)
                    + " · " + formatBytes(bytesPerSecond) + "/s");
            }
        });
    }

    private void publishSourceStatus(int source, int sourceCount) {
        runOnUiThread(() -> {
            if (progressDialog == null || !progressDialog.isShowing()) return;
            progressDialog.setIndeterminate(true);
            progressDialog.setProgress(0);
            progressDialog.setMessage("正在连接下载源 " + source + "/" + sourceCount + "…");
            progressDialog.getButton(ProgressDialog.BUTTON_NEUTRAL).setEnabled(source < sourceCount);
        });
    }

    private void showRetry(String message, Runnable retry) {
        if (!canShowUi()) return;
        new AlertDialog.Builder(activity)
            .setTitle("更新失败")
            .setMessage(message)
            .setNegativeButton("稍后更新", null)
            .setPositiveButton("重试", (dialog, which) -> retry.run())
            .show();
    }

    private String readUtf8(String url, int maxBytes) throws IOException {
        HttpURLConnection connection = openConnectionFollowingRedirects(url);
        try (InputStream input = connection.getInputStream()) {
            byte[] buffer = new byte[8192];
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > maxBytes) throw new IOException("Release response is too large");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openConnectionFollowingRedirects(String value) throws IOException {
        URL current = new URL(value);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!isAllowedNetworkUrl(current.toString())) {
                throw new IOException("不安全的下载地址");
            }
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/vnd.github+json, application/octet-stream");
            connection.setRequestProperty("User-Agent", "RP-Hub-Android-Updater");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IOException("下载重定向缺少地址");
                current = new URL(current, location);
                continue;
            }
            if (status < 200 || status >= 300) {
                connection.disconnect();
                throw new IOException("GitHub 请求失败（HTTP " + status + "）");
            }
            return connection;
        }
        throw new IOException("下载重定向次数过多");
    }

    private static boolean isAllowedDownloadUrl(String value) {
        try {
            URL url = new URL(value);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            return "gitee.com".equals(host)
                || "github.com".equals(host)
                || host.endsWith(".githubusercontent.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isAllowedNetworkUrl(String value) {
        try {
            URL url = new URL(value);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            return "gitee.com".equals(host)
                || "api.github.com".equals(host)
                || "github.com".equals(host)
                || host.endsWith(".githubusercontent.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        return packageVersionCode(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0));
    }

    private static long packageVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static byte[][] signatureBytes(Signature[] signatures) {
        byte[][] values = new byte[signatures.length][];
        for (int index = 0; index < signatures.length; index++) values[index] = signatures[index].toByteArray();
        return values;
    }

    private static int compareBytes(byte[] first, byte[] second) {
        int length = Math.min(first.length, second.length);
        for (int index = 0; index < length; index++) {
            int comparison = Integer.compare(first[index] & 0xff, second[index] & 0xff);
            if (comparison != 0) return comparison;
        }
        return Integer.compare(first.length, second.length);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item));
        return value.toString();
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024L * 1024L) return String.format(Locale.ROOT, "%.1f KB", bytes / 1024d);
        return String.format(Locale.ROOT, "%.1f MB", bytes / (1024d * 1024d));
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private boolean canShowUi() {
        return !destroyed.get() && !activity.isFinishing() && !activity.isDestroyed();
    }

    private void runOnUiThread(Runnable action) {
        if (!destroyed.get()) activity.runOnUiThread(() -> {
            if (!destroyed.get()) action.run();
        });
    }

    private void dismissProgress() {
        runOnUiThread(() -> {
            if (progressDialog != null) progressDialog.dismiss();
            progressDialog = null;
        });
    }
}
