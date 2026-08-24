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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class AppUpdateManager {
    private static final String TAG = "RPHubUpdate";
    private static final String LATEST_RELEASE_API = "https://api.github.com/repos/125pq/RP-Hub-app/releases/latest";
    private static final String GITEE_UPDATE_MANIFEST =
        "https://gitee.com/pq125pq/rp-hub-app/raw/android-latest/android-update.json";
    private static final int UNKNOWN_APPS_REQUEST = 19082;
    private static final int CONNECT_TIMEOUT_MS = 12000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final long SLOW_SOURCE_GRACE_MS = 3000L;
    private static final long MIN_DOWNLOAD_BYTES_PER_SECOND = 150L * 1024L;

    private final MainActivity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private final AtomicBoolean checkInProgress = new AtomicBoolean(false);
    private final AtomicBoolean downloadCancelled = new AtomicBoolean(false);
    private final AtomicInteger requestedSourceIndex = new AtomicInteger(-1);
    private final AtomicInteger currentSourceIndex = new AtomicInteger(-1);
    private final AtomicInteger availableSourceCount = new AtomicInteger(1);
    private final ConnectionGate connectionGate = new ConnectionGate();
    private final AtomicReference<CheckRequest> activeCheck = new AtomicReference<>();
    private final Runnable coldStartCheck = this::checkQuietly;
    private AppUpdateRelease pendingInstall;
    private File pendingApk;
    private ProgressDialog progressDialog;

    interface CheckCallback {
        void onComplete(String status, String message);

        default void onCancelled(String message) {
            onComplete("cancelled", message);
        }
    }

    static final class CheckRequest {
        final CheckCallback callback;
        final AtomicBoolean settled = new AtomicBoolean(false);

        CheckRequest(CheckCallback callback) {
            this.callback = callback;
        }

        void complete(String status, String message) {
            if (settled.compareAndSet(false, true)) callback.onComplete(status, message);
        }

        void cancel(String message) {
            if (settled.compareAndSet(false, true)) callback.onCancelled(message);
        }
    }

    static final class ConnectionGate {
        private final AtomicLong generation = new AtomicLong(0L);
        private final AtomicReference<HttpURLConnection> activeConnection = new AtomicReference<>();
        private final Object lock = new Object();

        long generation() {
            return generation.get();
        }

        void check(long expectedGeneration) throws IOException {
            if (expectedGeneration >= 0 && generation.get() != expectedGeneration) {
                throw new IOException("用户切换下载源");
            }
        }

        void install(HttpURLConnection connection, long expectedGeneration) throws IOException {
            synchronized (lock) {
                try {
                    check(expectedGeneration);
                } catch (IOException error) {
                    connection.disconnect();
                    throw error;
                }
                activeConnection.set(connection);
            }
        }

        void clear(HttpURLConnection connection) {
            synchronized (lock) {
                activeConnection.compareAndSet(connection, null);
            }
        }

        void invalidate() {
            HttpURLConnection connection;
            synchronized (lock) {
                generation.incrementAndGet();
                connection = activeConnection.getAndSet(null);
            }
            if (connection != null) connection.disconnect();
        }
    }

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
        connectionGate.invalidate();
        CheckRequest request = activeCheck.getAndSet(null);
        if (request != null) request.cancel("更新检查已取消");
        dismissProgress();
        destroyed.set(true);
        executor.shutdownNow();
    }

    private void checkQuietly() {
        checkNow((status, message) -> {
            if ("failed".equals(status) || "cancelled".equals(status)) {
                Log.i(TAG, "Update check skipped: " + message);
            }
        });
    }

    void checkNow(CheckCallback callback) {
        CheckRequest request = new CheckRequest(callback);
        if (!checkInProgress.compareAndSet(false, true)) {
            request.complete("busy", "正在检查更新");
            return;
        }
        activeCheck.set(request);
        try {
            executor.execute(() -> runCheck(request));
        } catch (RejectedExecutionException error) {
            finishCheck(request);
            request.cancel("更新检查服务已关闭");
        }
    }

    private void runCheck(CheckRequest request) {
        try {
            if (destroyed.get()) {
                request.cancel("更新检查已取消");
                return;
            }
            try {
                AppUpdateRelease release = fetchLatestRelease();
                if (release == null || release.versionCode <= installedVersionCode()) {
                    request.complete("latest", "已是最新版本");
                    return;
                }
                request.complete("update_available", "发现新版本 " + release.versionName);
                runOnUiThread(() -> {
                    if (!destroyed.get()) showUpdateDialog(release);
                });
            } catch (Exception error) {
                request.complete("failed", safeMessage(error));
            }
        } finally {
            finishCheck(request);
        }
    }

    private void finishCheck(CheckRequest request) {
        activeCheck.compareAndSet(request, null);
        checkInProgress.set(false);
    }

    private AppUpdateRelease fetchLatestRelease() throws IOException, JSONException {
        Exception lastError = null;
        AppUpdateRelease githubRelease = null;
        try {
            githubRelease = parseGitHubRelease(new JSONObject(readUtf8(LATEST_RELEASE_API, MAX_RESPONSE_BYTES)));
        } catch (IOException | JSONException error) {
            lastError = error;
        }
        try {
            AppUpdateRelease mirrorRelease = parseUpdateManifest(
                new JSONObject(readUtf8(GITEE_UPDATE_MANIFEST, MAX_RESPONSE_BYTES))
            );
            if (githubRelease == null) {
                Log.i(TAG, "Update metadata source: Gitee mirror fallback");
                return mirrorRelease;
            }
            if (githubRelease.versionCode == mirrorRelease.versionCode
                && githubRelease.sha256.equals(mirrorRelease.sha256)) {
                Log.i(TAG, "Update metadata source: GitHub API with Gitee download fallback");
                return mirrorRelease;
            }
            Log.i(TAG, "Gitee mirror metadata differs; using GitHub only");
        } catch (IOException | JSONException error) {
            lastError = error;
        }
        if (githubRelease != null) {
            Log.i(TAG, "Update metadata source: GitHub API");
            return githubRelease;
        }
        if (lastError instanceof IOException) throw (IOException) lastError;
        throw new IOException("所有更新源均不可用", lastError);
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
                java.util.Collections.singletonList(java.util.Collections.singletonList(url)),
                asset.optLong("size", -1L),
                sha
            );
        }
        return null;
    }

    private AppUpdateRelease parseUpdateManifest(JSONObject json) throws JSONException {
        if (json.optInt("schemaVersion") != 1) throw new JSONException("不支持的更新清单版本");
        String versionName = json.getString("versionName");
        long versionCode = json.getLong("versionCode");
        AppUpdateRelease.Version tagVersion = AppUpdateRelease.parseAndroidTag(json.getString("tag"));
        if (tagVersion == null || tagVersion.code != versionCode || !tagVersion.name.equals(versionName)) {
            throw new JSONException("更新清单版本信息不一致");
        }
        JSONObject apk = json.getJSONObject("apk");
        String apkName = apk.getString("name");
        String expectedName = "RP-Hub-" + versionName + "-release.apk";
        String sha = AppUpdateRelease.normalizeSha256(apk.getString("sha256"));
        List<List<String>> downloadSources = manifestDownloadSources(apk);
        if (!expectedName.equals(apkName) || sha == null || downloadSources.isEmpty()) {
            throw new JSONException("更新清单 APK 信息无效");
        }
        return new AppUpdateRelease(
            versionName,
            versionCode,
            json.optString("notes", ""),
            apkName,
            downloadSources,
            apk.optLong("size", -1L),
            sha
        );
    }

    private static List<List<String>> manifestDownloadSources(JSONObject apk) throws JSONException {
        List<List<String>> sources = new ArrayList<>();
        JSONArray values = apk.optJSONArray("sources");
        if (values == null) throw new JSONException("更新清单缺少 APK 下载源");
        for (int sourceIndex = 0; sourceIndex < values.length(); sourceIndex++) {
            JSONArray parts = values.optJSONArray(sourceIndex);
            if (parts == null || parts.length() == 0) throw new JSONException("更新清单下载源为空");
            LinkedHashSet<String> urls = new LinkedHashSet<>();
            for (int partIndex = 0; partIndex < parts.length(); partIndex++) {
                String value = parts.optString(partIndex, "");
                if (!isAllowedDownloadUrl(value)) throw new JSONException("更新清单包含不安全的 APK 地址");
                urls.add(value);
            }
            sources.add(new ArrayList<>(urls));
        }
        return sources;
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
        requestedSourceIndex.set(-1);
        currentSourceIndex.set(-1);
        connectionGate.invalidate();
        availableSourceCount.set(Math.max(1, release.apkSources.size()));
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
        int index = 0;
        for (int attempt = 0; attempt < release.apkSources.size(); attempt++) {
            int requested = requestedSourceIndex.getAndSet(-1);
            if (requested >= 0 && requested < release.apkSources.size()) index = requested;
            List<String> parts = release.apkSources.get(index);
            currentSourceIndex.set(index);
            long generation = connectionGate.generation();
            publishSourceStatus(index + 1, release.apkSources.size());
            try {
                downloadAndVerifyFromParts(release, destination, parts, release.apkSources.size() > 1, generation);
                Log.i(TAG, "Verified APK source with " + parts.size() + " part(s)");
                return;
            } catch (Exception error) {
                if (downloadCancelled.get()) throw error;
                lastError = error;
                Log.i(TAG, "APK source failed, trying next (" + error.getMessage() + ")");
                int next = requestedSourceIndex.getAndSet(-1);
                index = next >= 0 && next < release.apkSources.size()
                    ? next
                    : (index + 1) % release.apkSources.size();
            }
        }
        throw new IOException("所有 APK 下载源均失败", lastError);
    }

    private void downloadAndVerifyFromParts(
        AppUpdateRelease release,
        File destination,
        List<String> partUrls,
        boolean switchWhenSlow,
        long generation
    ) throws Exception {
        File parent = destination.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) throw new IOException("无法创建更新缓存目录");
        File temporary = new File(parent, destination.getName() + ".part");
        if (temporary.exists() && !temporary.delete()) throw new IOException("无法清理旧下载");

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long downloaded = 0L;
        long startedAt = android.os.SystemClock.elapsedRealtime();
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            for (String partUrl : partUrls) {
                HttpURLConnection connection = openConnectionFollowingRedirects(partUrl, generation);
                try {
                    connectionGate.check(generation);
                    InputStream rawInput = connection.getInputStream();
                    connectionGate.check(generation);
                    try (InputStream input = new BufferedInputStream(rawInput)) {
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (downloadCancelled.get() || Thread.currentThread().isInterrupted()) throw new IOException("下载已取消");
                            connectionGate.check(generation);
                            output.write(buffer, 0, count);
                            digest.update(buffer, 0, count);
                            downloaded += count;
                            long elapsed = android.os.SystemClock.elapsedRealtime() - startedAt;
                            long bytesPerSecond = downloaded * 1000L / Math.max(1L, elapsed);
                            publishProgress(downloaded, release.apkSize, bytesPerSecond);
                            if (switchWhenSlow && elapsed >= SLOW_SOURCE_GRACE_MS
                                && bytesPerSecond < MIN_DOWNLOAD_BYTES_PER_SECOND) {
                                throw new IOException("当前下载源速度过慢（" + (bytesPerSecond / 1024L) + " KB/s），正在切换");
                            }
                        }
                    }
                } finally {
                    connectionGate.clear(connection);
                    connection.disconnect();
                }
            }
            output.getFD().sync();
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
        progressDialog.setButton(ProgressDialog.BUTTON_NEUTRAL,
            release.apkSources.size() > 1 ? "切换到 Gitee" : "切换源", (dialog, which) -> {});
        progressDialog.setButton(ProgressDialog.BUTTON_NEGATIVE, "取消", (dialog, which) -> {});
        progressDialog.show();
        progressDialog.getButton(ProgressDialog.BUTTON_NEUTRAL).setOnClickListener(view -> requestSourceSwitch());
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
            int currentIndex = Math.max(0, source - 1);
            String current = sourceLabel(currentIndex);
            String target = sourceLabel((currentIndex + 1) % Math.max(1, sourceCount));
            progressDialog.setMessage("正在连接 " + current + "（" + source + "/" + sourceCount + "）…");
            progressDialog.getButton(ProgressDialog.BUTTON_NEUTRAL).setText(
                sourceCount > 1 ? "切换到 " + target : "切换源"
            );
            progressDialog.getButton(ProgressDialog.BUTTON_NEUTRAL).setEnabled(sourceCount > 1);
        });
    }

    private void requestSourceSwitch() {
        int current = currentSourceIndex.get();
        int sourceCount = Math.max(1, availableSourceCount.get());
        requestedSourceIndex.set(current < 0 ? 1 % sourceCount : (current + 1) % sourceCount);
        connectionGate.invalidate();
    }

    private static String sourceLabel(int index) {
        return index == 1 ? "Gitee" : "GitHub";
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
        return openConnectionFollowingRedirects(value, -1L);
    }

    private HttpURLConnection openConnectionFollowingRedirects(String value, long generation) throws IOException {
        URL current = new URL(value);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!isAllowedNetworkUrl(current.toString())) {
                throw new IOException("不安全的下载地址");
            }
            connectionGate.check(generation);
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            boolean returned = false;
            try {
                connectionGate.install(connection, generation);
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "application/vnd.github+json, application/octet-stream");
                connection.setRequestProperty("User-Agent", "RP-Hub-Android-Updater");
                int status = connection.getResponseCode();
                connectionGate.check(generation);
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("下载重定向缺少地址");
                    current = new URL(current, location);
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new IOException("GitHub 请求失败（HTTP " + status + "）");
                }
                returned = true;
                return connection;
            } finally {
                if (!returned) {
                    connectionGate.clear(connection);
                    connection.disconnect();
                }
            }
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
