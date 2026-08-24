package io.github.pq125.rphub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import androidx.appcompat.app.AppCompatDelegate;
import org.junit.Test;

public class NativeThemePluginTest {
    @Test
    public void mapsSupportedModesToAppCompatNightModes() {
        assertEquals(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM, NativeThemePlugin.nightModeFor("system"));
        assertEquals(AppCompatDelegate.MODE_NIGHT_NO, NativeThemePlugin.nightModeFor("light"));
        assertEquals(AppCompatDelegate.MODE_NIGHT_YES, NativeThemePlugin.nightModeFor("dark"));
    }

    @Test
    public void rejectsUnsupportedModesDuringNormalization() {
        assertEquals("system", NativeThemePlugin.normalizeMode("system"));
        assertEquals("light", NativeThemePlugin.normalizeMode("light"));
        assertEquals("dark", NativeThemePlugin.normalizeMode("dark"));
        assertNull(NativeThemePlugin.normalizeMode("off"));
        assertNull(NativeThemePlugin.normalizeMode(null));
    }
}
