package io.github.pq125.rphub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class AppUpdateManagerConcurrencyTest {
    @Test
    public void checkRequestCompletesExactlyOnce() {
        AtomicInteger completed = new AtomicInteger();
        AtomicInteger cancelled = new AtomicInteger();
        AppUpdateManager.CheckRequest request = new AppUpdateManager.CheckRequest(callback(completed, cancelled));

        request.complete("latest", "已是最新版本");
        request.complete("failed", "不应重复结算");
        request.cancel("不应在完成后取消");

        assertEquals(1, completed.get());
        assertEquals(0, cancelled.get());
    }

    @Test
    public void cancelledCheckRequestCannotCompleteLater() {
        AtomicInteger completed = new AtomicInteger();
        AtomicInteger cancelled = new AtomicInteger();
        AppUpdateManager.CheckRequest request = new AppUpdateManager.CheckRequest(callback(completed, cancelled));

        request.cancel("Activity 已销毁");
        request.complete("latest", "不应在取消后完成");
        request.cancel("不应重复取消");

        assertEquals(0, completed.get());
        assertEquals(1, cancelled.get());
    }

    @Test
    public void invalidationDisconnectsInstalledConnectionAndStalesGeneration() throws Exception {
        AppUpdateManager.ConnectionGate gate = new AppUpdateManager.ConnectionGate();
        long generation = gate.generation();
        FakeConnection connection = new FakeConnection();

        gate.install(connection, generation);
        gate.invalidate();

        assertEquals(1, connection.disconnectCount.get());
        assertThrows(IOException.class, () -> gate.check(generation));
    }

    @Test
    public void staleConnectionIsDisconnectedBeforeItCanBlock() throws Exception {
        AppUpdateManager.ConnectionGate gate = new AppUpdateManager.ConnectionGate();
        long staleGeneration = gate.generation();
        gate.invalidate();
        FakeConnection connection = new FakeConnection();

        assertThrows(IOException.class, () -> gate.install(connection, staleGeneration));
        assertEquals(1, connection.disconnectCount.get());
    }

    private static AppUpdateManager.CheckCallback callback(
        AtomicInteger completed,
        AtomicInteger cancelled
    ) {
        return new AppUpdateManager.CheckCallback() {
            @Override
            public void onComplete(String status, String message) {
                completed.incrementAndGet();
            }

            @Override
            public void onCancelled(String message) {
                cancelled.incrementAndGet();
            }
        };
    }

    private static final class FakeConnection extends HttpURLConnection {
        final AtomicInteger disconnectCount = new AtomicInteger();

        FakeConnection() throws Exception {
            super(new URL("https://github.com/125pq/RP-Hub-app/releases/latest"));
        }

        @Override
        public void disconnect() {
            disconnectCount.incrementAndGet();
        }

        @Override
        public boolean usingProxy() {
            return false;
        }

        @Override
        public void connect() {}
    }
}
