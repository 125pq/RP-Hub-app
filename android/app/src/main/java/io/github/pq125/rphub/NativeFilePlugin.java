package io.github.pq125.rphub;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "NativeFile")
public class NativeFilePlugin extends Plugin {

    private static final Pattern MIME_PATTERN = Pattern.compile("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$");
    private static final Pattern MISPLACED_JSON_COPY_SUFFIX = Pattern.compile("^(.*)(\\.jsonl?)\\s*\\((\\d+)\\)$", Pattern.CASE_INSENSITIVE);
    private static final int MAX_DUPLICATE_RENAME_ATTEMPTS = 1000;
    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private final Object stateLock = new Object();
    private boolean saveReserved;
    private SaveSession session;

    private static final class SaveSession {
        final String id;
        final Uri uri;
        final OutputStream stream;
        int nextChunkIndex;
        long bytesWritten;

        SaveSession(String id, Uri uri, OutputStream stream) {
            this.id = id;
            this.uri = uri;
            this.stream = stream;
        }
    }

    @PluginMethod
    public void beginSave(PluginCall call) {
        String filename = sanitizeFilename(call.getString("filename", ""));
        String mimeType = normalizeMimeType(call.getString("mimeType", "application/octet-stream"));
        if (filename.isEmpty()) {
            call.reject("A valid filename is required", "invalid_filename");
            return;
        }
        if (mimeType == null) {
            call.reject("A valid MIME type is required", "invalid_mime");
            return;
        }

        synchronized (stateLock) {
            if (saveReserved || session != null) {
                call.reject("A save is already in progress", "save_in_progress");
                return;
            }
            saveReserved = true;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_TITLE, filename);
        try {
            startActivityForResult(call, intent, "savePickerResult");
        } catch (ActivityNotFoundException error) {
            clearReservation();
            call.reject("No document picker is available", "picker_unavailable");
        } catch (RuntimeException error) {
            clearReservation();
            call.reject("Could not open the document picker", "picker_unavailable");
        }
    }

    @ActivityCallback
    private void savePickerResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            clearReservation();
            return;
        }
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            clearReservation();
            JSObject response = new JSObject();
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }

        fileExecutor.execute(() -> {
            try {
                Uri outputUri = normalizeDuplicateDocumentName(uri);
                OutputStream stream = getContext().getContentResolver().openOutputStream(outputUri, "wt");
                if (stream == null) throw new IOException("Document provider returned no output stream");
                SaveSession newSession = new SaveSession(UUID.randomUUID().toString(), outputUri, stream);
                synchronized (stateLock) {
                    session = newSession;
                    saveReserved = false;
                }
                JSObject response = new JSObject();
                response.put("cancelled", false);
                response.put("sessionId", newSession.id);
                call.resolve(response);
            } catch (IOException | SecurityException error) {
                clearReservation();
                call.reject("Could not open the selected document", "cannot_open_stream");
            }
        });
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        Integer index = call.getInt("index");
        String encoding = call.getString("encoding", "utf8");
        String data = call.getString("data");
        if (index == null || index < 0 || data == null) {
            call.reject("Invalid chunk", "invalid_chunk");
            return;
        }

        fileExecutor.execute(() -> {
            SaveSession current = getSession(sessionId);
            if (current == null) {
                call.reject("Save session not found", "session_not_found");
                return;
            }
            if (index != current.nextChunkIndex) {
                closeAndClear(current);
                call.reject("Chunk arrived out of order", "chunk_out_of_order");
                return;
            }
            try {
                byte[] bytes;
                if ("utf8".equals(encoding)) {
                    bytes = data.getBytes(StandardCharsets.UTF_8);
                } else if ("base64".equals(encoding)) {
                    bytes = Base64.decode(data, Base64.DEFAULT);
                } else {
                    closeAndClear(current);
                    call.reject("Unsupported chunk encoding", "invalid_encoding");
                    return;
                }
                current.stream.write(bytes);
                current.bytesWritten += bytes.length;
                current.nextChunkIndex += 1;
                JSObject response = new JSObject();
                response.put("nextChunkIndex", current.nextChunkIndex);
                response.put("bytesWritten", current.bytesWritten);
                call.resolve(response);
            } catch (IOException | IllegalArgumentException error) {
                closeAndClear(current);
                call.reject("Could not write the selected document", "write_failed");
            }
        });
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        fileExecutor.execute(() -> {
            SaveSession current = getSession(sessionId);
            if (current == null) {
                call.reject("Save session not found", "session_not_found");
                return;
            }
            try {
                current.stream.flush();
                current.stream.close();
                clearSession(current);
                JSObject response = new JSObject();
                response.put("cancelled", false);
                response.put("bytesWritten", current.bytesWritten);
                response.put("uri", current.uri.toString());
                call.resolve(response);
            } catch (IOException error) {
                closeAndClear(current);
                call.reject("Could not finish the selected document", "write_failed");
            }
        });
    }

    @PluginMethod
    public void cancelSave(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        fileExecutor.execute(() -> {
            SaveSession current = getSession(sessionId);
            if (current == null) {
                call.resolve(new JSObject().put("cancelled", true));
                return;
            }
            closeAndClear(current);
            call.resolve(new JSObject().put("cancelled", true));
        });
    }

    @Override
    protected void handleOnDestroy() {
        SaveSession current;
        synchronized (stateLock) {
            current = session;
            session = null;
            saveReserved = false;
        }
        if (current != null) {
            try {
                current.stream.close();
            } catch (IOException ignored) {}
        }
        fileExecutor.shutdownNow();
    }

    private SaveSession getSession(String sessionId) {
        synchronized (stateLock) {
            return session != null && session.id.equals(sessionId) ? session : null;
        }
    }

    private void clearSession(SaveSession expected) {
        synchronized (stateLock) {
            if (session == expected) session = null;
        }
    }

    private void closeAndClear(SaveSession current) {
        try {
            current.stream.close();
        } catch (IOException ignored) {}
        clearSession(current);
    }

    private void clearReservation() {
        synchronized (stateLock) {
            saveReserved = false;
        }
    }

    static String sanitizeFilename(String value) {
        if (value == null) return "";
        return value.trim().replaceAll("[\\x00-\\x1F\\x7F/\\\\:*?\"<>|]", "_");
    }

    static String normalizeDuplicateFilename(String filename) {
        if (filename == null) return null;
        Matcher matcher = MISPLACED_JSON_COPY_SUFFIX.matcher(filename);
        return matcher.matches()
            ? matcher.group(1).replaceFirst("\\s+$", "") + " (" + matcher.group(3) + ")" + matcher.group(2)
            : filename;
    }

    private Uri normalizeDuplicateDocumentName(Uri uri) {
        String currentName = null;
        try (Cursor cursor = getContext().getContentResolver().query(
            uri,
            new String[] { OpenableColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameColumn >= 0) currentName = cursor.getString(nameColumn);
            }
        } catch (RuntimeException ignored) {
            return uri;
        }

        Matcher matcher = MISPLACED_JSON_COPY_SUFFIX.matcher(currentName == null ? "" : currentName);
        if (!matcher.matches()) return uri;

        String base = matcher.group(1).replaceFirst("\\s+$", "");
        String extension = matcher.group(2);
        int suffix;
        try {
            suffix = Integer.parseInt(matcher.group(3));
        } catch (NumberFormatException ignored) {
            suffix = 1;
        }

        for (int candidateSuffix = suffix; candidateSuffix < suffix + MAX_DUPLICATE_RENAME_ATTEMPTS; candidateSuffix++) {
            String candidate = base + " (" + candidateSuffix + ")" + extension;
            try {
                Uri renamedUri = DocumentsContract.renameDocument(
                    getContext().getContentResolver(),
                    uri,
                    candidate
                );
                return renamedUri == null ? uri : renamedUri;
            } catch (IOException | RuntimeException ignored) {
                // Name already in use (or provider rejected it): try the next suffix.
            }
        }
        return uri;
    }

    static String normalizeMimeType(String value) {
        if (value == null) return null;
        String mimeType = value.split(";", 2)[0].trim();
        return MIME_PATTERN.matcher(mimeType).matches() ? mimeType : null;
    }
}
