package io.github.pq125.rphub;

import android.app.Activity;
import android.content.Context;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeTheme")
public class NativeThemePlugin extends Plugin {
    static final String MODE_SYSTEM = "system";
    static final String MODE_LIGHT = "light";
    static final String MODE_DARK = "dark";
    private static final String PREFERENCES_NAME = "rphub_native_theme";
    private static final String MODE_KEY = "mode";

    static String normalizeMode(String mode) {
        if (MODE_SYSTEM.equals(mode) || MODE_LIGHT.equals(mode) || MODE_DARK.equals(mode)) return mode;
        return null;
    }

    static int nightModeFor(String mode) {
        switch (mode) {
            case MODE_SYSTEM:
                return AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
            case MODE_LIGHT:
                return AppCompatDelegate.MODE_NIGHT_NO;
            case MODE_DARK:
                return AppCompatDelegate.MODE_NIGHT_YES;
            default:
                throw new IllegalArgumentException("Unsupported theme mode");
        }
    }

    static void restoreNightMode(Context context) {
        String savedMode = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getString(MODE_KEY, MODE_SYSTEM);
        String mode = normalizeMode(savedMode);
        applyNightMode(mode == null ? MODE_SYSTEM : mode);
    }

    private static void applyNightMode(String mode) {
        int nightMode = nightModeFor(mode);
        if (AppCompatDelegate.getDefaultNightMode() != nightMode) {
            AppCompatDelegate.setDefaultNightMode(nightMode);
        }
    }

    @PluginMethod
    public void setMode(PluginCall call) {
        String mode = normalizeMode(call.getString("mode"));
        if (mode == null) {
            call.reject("mode must be system, light, or dark", "invalid_mode");
            return;
        }
        boolean saved = getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(MODE_KEY, mode)
            .commit();
        if (!saved) {
            call.reject("Could not persist theme mode", "persist_failed");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable", "activity_unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            applyNightMode(mode);
            call.resolve(new JSObject().put("mode", mode));
        });
    }
}
