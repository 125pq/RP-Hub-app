package io.github.pq125.rphub;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private AppUpdateManager appUpdateManager;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFilePlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        super.onCreate(savedInstanceState);
        appUpdateManager = new AppUpdateManager(this);
        if (savedInstanceState == null) appUpdateManager.checkOnColdStart();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (appUpdateManager != null) appUpdateManager.onActivityResult(requestCode);
    }

    @Override
    public void onDestroy() {
        if (appUpdateManager != null) appUpdateManager.destroy();
        super.onDestroy();
    }
}
