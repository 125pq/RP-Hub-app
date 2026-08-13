package io.github.pq125.rphub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class AppUpdateReleaseTest {
    private static final String SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    public void parsesAndroidReleaseTagAsVersionCode() {
        AppUpdateRelease.Version version = AppUpdateRelease.parseAndroidTag("v1.8.3-android");
        assertEquals("1.8.3", version.name);
        assertEquals(1080300L, version.code);

        AppUpdateRelease.Version revision = AppUpdateRelease.parseAndroidTag("v1.8.3-2-android");
        assertEquals("1.8.3-2", revision.name);
        assertEquals(1080302L, revision.code);
    }

    @Test
    public void rejectsNonAndroidAndUnsafeVersionTags() {
        assertNull(AppUpdateRelease.parseAndroidTag("1.8.3"));
        assertNull(AppUpdateRelease.parseAndroidTag("v1.100.0-android"));
        assertNull(AppUpdateRelease.parseAndroidTag("v1.8.3-100-android"));
        assertNull(AppUpdateRelease.parseAndroidTag("v1.8.3-android-rc1"));
        assertNull(AppUpdateRelease.parseAndroidTag("v999999999999999999999.1.1-android"));
    }

    @Test
    public void prefersAssetDigestAndFallsBackToReleaseNotes() {
        assertEquals(SHA, AppUpdateRelease.shaFromDigestOrNotes("sha256:" + SHA.toUpperCase(), ""));
        assertEquals(SHA, AppUpdateRelease.shaFromDigestOrNotes("", "APK SHA-256：`" + SHA + "`"));
        assertNull(AppUpdateRelease.shaFromDigestOrNotes("", "no checksum"));
    }
}
