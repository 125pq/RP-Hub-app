package io.github.pq125.rphub;

import android.webkit.WebView;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeTheme")
public class NativeThemePlugin extends Plugin {
    private Boolean appliedDarkening;

    @PluginMethod
    public void setAlgorithmicDarkening(PluginCall call) {
        boolean allowed = call.getBoolean("allowed", false);
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                boolean changed = appliedDarkening == null || appliedDarkening != allowed;
                if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                    WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.getSettings(), allowed);
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
                    WebSettingsCompat.setForceDark(
                        webView.getSettings(),
                        allowed ? WebSettingsCompat.FORCE_DARK_ON : WebSettingsCompat.FORCE_DARK_OFF
                    );
                }
                appliedDarkening = allowed;
                if (changed) webView.reload();
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("Unable to update theme", "theme_update_failed", error);
            }
        });
    }
}
