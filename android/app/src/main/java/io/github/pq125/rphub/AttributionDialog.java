package io.github.pq125.rphub;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;

/** Shows the one-time attribution and anti-resale notice for the Android client. */
final class AttributionDialog {
    private static final String PREFERENCES_NAME = "rphub_attribution";
    private static final String READ_KEY = "attribution_notice_v1";
    private static final String REPOSITORY_URL = "https://github.com/STA1N156/RP-Hub";
    private static final String WEB_URL = "https://sta1n156.github.io/RP-Hub/";

    private AttributionDialog() {}

    static void showIfNeeded(Activity activity, Runnable onAcknowledged) {
        if (isRead(activity)) {
            if (onAcknowledged != null) onAcknowledged.run();
            return;
        }
        if (activity.isFinishing() || activity.isDestroyed()) return;

        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("来源与防倒卖声明")
            .setMessage(
                "本应用为 RP-Hub Android 客户端。\n\n"
                    + "RP-Hub 由 STA1N156 开发并免费提供，原项目和网页版均免费。\n\n"
                    + "如果你是付费获得本应用或 RP-Hub，可能是未经授权的第三方倒卖。"
                    + "请尊重作者，请勿冒充原创或收费转售。"
            )
            .setPositiveButton("原项目仓库", null)
            .setNeutralButton("免费网页版", null)
            .setNegativeButton("知道了", (ignored, which) -> {
                markRead(activity);
                if (onAcknowledged != null) onAcknowledged.run();
            })
            .create();

        dialog.setCancelable(false);
        dialog.show();
        // Override the default button dismissal so opening either link does not acknowledge the notice.
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(
            view -> openUrl(activity, REPOSITORY_URL)
        );
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(
            view -> openUrl(activity, WEB_URL)
        );
    }

    private static boolean isRead(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getBoolean(READ_KEY, false);
    }

    private static void markRead(Context context) {
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(READ_KEY, true)
            .apply();
    }

    private static void openUrl(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(activity, "没有可打开链接的应用", Toast.LENGTH_SHORT).show();
        }
    }
}
