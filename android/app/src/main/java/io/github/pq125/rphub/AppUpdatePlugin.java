package io.github.pq125.rphub;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    @PluginMethod
    public void checkNow(PluginCall call) {
        MainActivity activity = getActivity() instanceof MainActivity
            ? (MainActivity) getActivity()
            : null;
        AppUpdateManager manager = activity == null ? null : activity.getAppUpdateManager();
        if (manager == null) {
            call.reject("更新服务不可用", "update_unavailable");
            return;
        }
        manager.checkNow(new AppUpdateManager.CheckCallback() {
            @Override
            public void onComplete(String status, String message) {
                call.resolve(new JSObject()
                        .put("status", status)
                        .put("message", message));
            }

            @Override
            public void onCancelled(String message) {
                call.reject(message, "update_cancelled");
            }
        });
    }
}
