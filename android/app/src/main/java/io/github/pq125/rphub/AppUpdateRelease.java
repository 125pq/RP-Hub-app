package io.github.pq125.rphub;

import java.util.Locale;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class AppUpdateRelease {
    private static final Pattern ANDROID_TAG = Pattern.compile("^v?(\\d+)\\.(\\d+)\\.(\\d+)-android$");
    private static final Pattern SHA_LINE = Pattern.compile(
        "(?im)APK\\s+SHA-?256\\s*[：:]\\s*`?([a-f0-9]{64})`?"
    );

    final String versionName;
    final long versionCode;
    final String notes;
    final String apkName;
    final List<String> apkUrls;
    final long apkSize;
    final String sha256;

    AppUpdateRelease(
        String versionName,
        long versionCode,
        String notes,
        String apkName,
        List<String> apkUrls,
        long apkSize,
        String sha256
    ) {
        this.versionName = versionName;
        this.versionCode = versionCode;
        this.notes = notes == null || notes.trim().isEmpty() ? "本次更新未提供说明。" : notes.trim();
        this.apkName = apkName;
        this.apkUrls = apkUrls;
        this.apkSize = apkSize;
        this.sha256 = normalizeSha256(sha256);
    }

    static Version parseAndroidTag(String tag) {
        Matcher matcher = ANDROID_TAG.matcher(tag == null ? "" : tag.trim());
        if (!matcher.matches()) return null;
        try {
            long major = Long.parseLong(matcher.group(1));
            long minor = Long.parseLong(matcher.group(2));
            long patch = Long.parseLong(matcher.group(3));
            if (major > 210000L || minor > 99 || patch > 99) return null;
            long code = major * 10000L + minor * 100L + patch;
            if (code < 1 || code > 2100000000L) return null;
            return new Version(major + "." + minor + "." + patch, code);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    static String shaFromDigestOrNotes(String digest, String notes) {
        String normalizedDigest = digest == null ? "" : digest.trim();
        if (normalizedDigest.regionMatches(true, 0, "sha256:", 0, 7)) {
            String value = normalizeSha256(normalizedDigest.substring(7));
            if (value != null) return value;
        }
        Matcher matcher = SHA_LINE.matcher(notes == null ? "" : notes);
        return matcher.find() ? normalizeSha256(matcher.group(1)) : null;
    }

    static String normalizeSha256(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        return normalized.matches("[a-f0-9]{64}") ? normalized : null;
    }

    static final class Version {
        final String name;
        final long code;

        Version(String name, long code) {
            this.name = name;
            this.code = code;
        }
    }
}
