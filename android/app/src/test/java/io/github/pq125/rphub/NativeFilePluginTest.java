package io.github.pq125.rphub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class NativeFilePluginTest {

    @Test
    public void movesAndroidCopySuffixBeforeJsonExtension() {
        assertEquals("角色(1).json", NativeFilePlugin.normalizeDuplicateFilename("角色.json(1)"));
        assertEquals("角色(5).json", NativeFilePlugin.normalizeDuplicateFilename("角色.json (5)"));
        assertEquals("聊天(12).jsonl", NativeFilePlugin.normalizeDuplicateFilename("聊天.jsonl(12)"));
        assertEquals("聊天(5).jsonl", NativeFilePlugin.normalizeDuplicateFilename("聊天.jsonl (5)"));
        assertEquals("CARD(2).JSON", NativeFilePlugin.normalizeDuplicateFilename("CARD.JSON(2)"));
    }

    @Test
    public void leavesOtherNamesUnchanged() {
        assertEquals("角色.json", NativeFilePlugin.normalizeDuplicateFilename("角色.json"));
        assertEquals("角色(1).json", NativeFilePlugin.normalizeDuplicateFilename("角色(1).json"));
        assertEquals("角色.png(1)", NativeFilePlugin.normalizeDuplicateFilename("角色.png(1)"));
        assertNull(NativeFilePlugin.normalizeDuplicateFilename(null));
    }
}
