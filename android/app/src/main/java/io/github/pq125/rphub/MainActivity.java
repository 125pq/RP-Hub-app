package io.github.pq125.rphub;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
