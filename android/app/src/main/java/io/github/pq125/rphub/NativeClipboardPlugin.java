package io.github.pq125.rphub;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeClipboard")
public class NativeClipboardPlugin extends Plugin {
    @PluginMethod
    public void readText(PluginCall call) {
        ClipboardManager clipboard = (ClipboardManager) getContext()
            .getSystemService(Context.CLIPBOARD_SERVICE);
        String value = "";
        if (clipboard != null && clipboard.hasPrimaryClip()) {
            ClipData clip = clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                if (text != null) value = text.toString();
            }
        }

        JSObject result = new JSObject();
        result.put("value", value);
        call.resolve(result);
    }
}
