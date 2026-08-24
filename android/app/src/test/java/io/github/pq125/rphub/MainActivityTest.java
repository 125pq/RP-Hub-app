package io.github.pq125.rphub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MainActivityTest {

    @Test
    public void acceptsOnlyHttpDownloadSchemes() {
        assertTrue(MainActivity.isHttpDownloadScheme("http"));
        assertTrue(MainActivity.isHttpDownloadScheme("HTTPS"));
        assertFalse(MainActivity.isHttpDownloadScheme("blob"));
        assertFalse(MainActivity.isHttpDownloadScheme("data"));
        assertFalse(MainActivity.isHttpDownloadScheme(null));
    }

    @Test
    public void identifiesBlobAndDataForNativeRoute() {
        assertTrue(MainActivity.isBlobOrDataScheme("blob"));
        assertTrue(MainActivity.isBlobOrDataScheme("DATA"));
        assertFalse(MainActivity.isBlobOrDataScheme("https"));
    }

    @Test
    public void normalizesDownloadMimeTypeWithoutParameters() {
        assertEquals("image/png", MainActivity.normalizeMimeType("image/png; charset=binary"));
        assertEquals("application/octet-stream", MainActivity.normalizeMimeType(" application/octet-stream "));
        assertNull(MainActivity.normalizeMimeType("not-a-mime"));
        assertNull(MainActivity.normalizeMimeType(null));
    }

    @Test
    public void infersSquareRefererWhenDownloadComesFromIframe() {
        assertEquals(
            "https://rphforum.zeabur.app/",
            MainActivity.inferDownloadReferer(
                "https://localhost/",
                "https://rphforum.zeabur.app/api/cards/1/download"
            )
        );
        assertEquals(
            "https://rphforum.zeabur.app/card/1",
            MainActivity.inferDownloadReferer(
                "https://rphforum.zeabur.app/card/1",
                "https://rphforum.zeabur.app/api/cards/1/download"
            )
        );
        assertNull(MainActivity.inferDownloadReferer(
            "https://localhost/",
            "https://example.test/file.bin"
        ));
    }

    @Test
    public void namesDownloadManagerStatusesAndFailures() {
        assertEquals("successful", MainActivity.downloadStatusName(android.app.DownloadManager.STATUS_SUCCESSFUL));
        assertEquals("failed", MainActivity.downloadStatusName(android.app.DownloadManager.STATUS_FAILED));
        assertEquals("http_data_error", MainActivity.downloadFailureReasonName(android.app.DownloadManager.ERROR_HTTP_DATA_ERROR));
        assertEquals("unhandled_http_code", MainActivity.downloadFailureReasonName(android.app.DownloadManager.ERROR_UNHANDLED_HTTP_CODE));
        assertEquals("reason_-99", MainActivity.downloadFailureReasonName(-99));
    }

    @Test
    public void documentStartBridgeUsesOnlySquareOrigins() {
        assertEquals(2, MainActivity.SQUARE_ORIGIN_RULES.size());
        assertTrue(MainActivity.SQUARE_ORIGIN_RULES.contains("https://rphforum.zeabur.app"));
        assertTrue(MainActivity.SQUARE_ORIGIN_RULES.contains("https://rp.zhaoyangxx.ccwu.cc"));
    }
}
