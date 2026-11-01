package com.tahablt.bridge;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity {
    public static final String QUICK_PREFS_NAME = "bridge_quick_prefs";
    public static final String QUICK_PREFS_DEVICE_KEY = "active_device_json";
    public static final String QUICK_PREFS_ALL_DEVICES_KEY = "all_devices_json";

    private static final String MEDIA_CHANNEL_ID = "bridge_media_channel";
    private static final int MEDIA_NOTIFICATION_ID = 4850;
    private static final String QUICK_CHANNEL_ID = "bridge_quick_channel";
    private static final int QUICK_NOTIFICATION_ID = 4851;

    private static final String ACTION_MEDIA_PREV = "com.tahablt.bridge.MEDIA_PREV";
    private static final String ACTION_MEDIA_PLAY_PAUSE = "com.tahablt.bridge.MEDIA_PLAY_PAUSE";
    private static final String ACTION_MEDIA_NEXT = "com.tahablt.bridge.MEDIA_NEXT";
    private static final String ACTION_MEDIA_MUTE = "com.tahablt.bridge.MEDIA_MUTE";
    private static final String ACTION_MEDIA_DISMISSED = "com.tahablt.bridge.MEDIA_DISMISSED";

    private static volatile MainActivity currentInstance = null;
    private static final ExecutorService QUICK_ACTION_EXECUTOR = Executors.newCachedThreadPool();

    private WebView webView;
    private android.widget.FrameLayout rootContainer;
    private boolean isLandscapeFullscreen = false;
    private int currentNavBarColor = Color.parseColor("#121216");
    private int lastInsetTop = 0;
    private int lastInsetBottom = 0;
    private int lastInsetLeft = 0;
    private int lastInsetRight = 0;
    private final android.graphics.Paint navBarScrimPaint = new android.graphics.Paint();
    private MediaSession mediaSession;
    private NotificationManager notificationManager;
    private BroadcastReceiver mediaReceiver;
    private String lastMediaJson = "";
    private String currentMediaTrackKey = "";
    private String dismissedMediaTrackKey = "";
    private boolean mediaNotificationEnabled = true;
    private android.webkit.ValueCallback<android.net.Uri[]> filePathCallback = null;
    private static final int FILE_CHOOSER_RESULT_CODE = 4855;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentInstance = this;

        Window window = getWindow();
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.parseColor("#09090B"));
        window.setNavigationBarColor(currentNavBarColor);
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                window.setNavigationBarDividerColor(Color.TRANSPARENT);
            }
            if (Build.VERSION.SDK_INT >= 29) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= 30 && window.getInsetsController() != null) {
                window.getInsetsController().setSystemBarsAppearance(
                        0,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
        } catch (Exception ignored) {
        }

        // Request POST_NOTIFICATIONS permission on Android 13+ (API 33+) so Media & Quick Control Notifications work
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 101);
                }
            } catch (Exception ignored) {
            }
        }

        setupMediaSessionAndNotificationChannel();

        rootContainer = new android.widget.FrameLayout(this) {
            @Override
            protected void dispatchDraw(android.graphics.Canvas canvas) {
                super.dispatchDraw(canvas);
                int padB = getPaddingBottom();
                if (!isLandscapeFullscreen && padB > 0) {
                    navBarScrimPaint.setColor(currentNavBarColor);
                    canvas.drawRect(0, getHeight() - padB, getWidth(), getHeight(), navBarScrimPaint);
                }
            }
        };
        rootContainer.setBackgroundColor(Color.parseColor("#09090B"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#09090B"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setTextZoom(100);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                syncSafeAreaToWeb();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, android.webkit.ValueCallback<android.net.Uri[]> filePathCallbackParam, FileChooserParams fileChooserParams) {
                try {
                    if (filePathCallback != null) {
                        filePathCallback.onReceiveValue(null);
                    }
                    filePathCallback = filePathCallbackParam;
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(intent, "PC'ye Gönderilecek Dosyayı Seçin"), FILE_CHOOSER_RESULT_CODE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });
        webView.addJavascriptInterface(new NativeBridge(this), "TahaNative");

        rootContainer.addView(webView, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
        ));

        setupEdgeToEdgeInsetsHandling();

        setContentView(rootContainer);
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (filePathCallback == null) return;
            android.net.Uri[] results = null;
            try {
                if (resultCode == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new android.net.Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new android.net.Uri[]{data.getData()};
                    }
                }
            } catch (Exception ignored) {
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private int getFallbackStatusBarHeightPx() {
        try {
            int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (resId > 0) {
                return getResources().getDimensionPixelSize(resId);
            }
        } catch (Exception ignored) {
        }
        return Math.round(24f * getResources().getDisplayMetrics().density);
    }

    private void setupEdgeToEdgeInsetsHandling() {
        if (rootContainer == null) return;

        rootContainer.setOnApplyWindowInsetsListener((v, insets) -> {
            if (insets == null) return insets;
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets sysBars = insets.getInsets(
                            android.view.WindowInsets.Type.systemBars()
                                    | android.view.WindowInsets.Type.displayCutout()
                    );
                    android.graphics.Insets imeInsets = insets.getInsets(
                            android.view.WindowInsets.Type.ime()
                    );
                    lastInsetTop = sysBars.top;
                    lastInsetBottom = Math.max(sysBars.bottom, imeInsets.bottom);
                    lastInsetLeft = sysBars.left;
                    lastInsetRight = sysBars.right;
                } else {
                    lastInsetTop = insets.getSystemWindowInsetTop();
                    lastInsetBottom = insets.getSystemWindowInsetBottom();
                    lastInsetLeft = insets.getSystemWindowInsetLeft();
                    lastInsetRight = insets.getSystemWindowInsetRight();
                    if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                        android.view.DisplayCutout cutout = insets.getDisplayCutout();
                        lastInsetTop = Math.max(lastInsetTop, cutout.getSafeInsetTop());
                        lastInsetBottom = Math.max(lastInsetBottom, cutout.getSafeInsetBottom());
                        lastInsetLeft = Math.max(lastInsetLeft, cutout.getSafeInsetLeft());
                        lastInsetRight = Math.max(lastInsetRight, cutout.getSafeInsetRight());
                    }
                }
                applyCalculatedSafePadding();
            } catch (Exception ignored) {
            }
            return insets;
        });

        rootContainer.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (top != oldTop || bottom != oldBottom || left != oldLeft || right != oldRight) {
                v.post(this::applyCalculatedSafePadding);
            }
        });

        rootContainer.post(this::applyCalculatedSafePadding);
    }

    private void applyCalculatedSafePadding() {
        if (rootContainer == null) return;
        try {
            if (isLandscapeFullscreen) {
                if (rootContainer.getPaddingTop() != 0 || rootContainer.getPaddingBottom() != 0
                        || rootContainer.getPaddingLeft() != 0 || rootContainer.getPaddingRight() != 0) {
                    rootContainer.setPadding(0, 0, 0, 0);
                    rootContainer.invalidate();
                }
                syncSafeAreaToWeb();
                return;
            }

            int requiredTop = Math.max(lastInsetTop, getFallbackStatusBarHeightPx());
            int[] loc = new int[2];
            rootContainer.getLocationOnScreen(loc);
            int viewTopOnScreen = Math.max(0, loc[1]);

            View decor = getWindow() != null ? getWindow().getDecorView() : null;
            int decorH = decor != null ? decor.getHeight() : 0;
            int viewH = rootContainer.getHeight();

            int padTop;
            int padBottom;
            if (decorH > 0 && viewH > 0) {
                padTop = Math.max(0, requiredTop - viewTopOnScreen);
                int alreadyBottomOffset = Math.max(0, decorH - (viewTopOnScreen + viewH));
                padBottom = Math.max(0, lastInsetBottom - alreadyBottomOffset);
            } else {
                padTop = requiredTop;
                padBottom = lastInsetBottom;
            }

            int padLeft = Math.max(0, lastInsetLeft - Math.max(0, loc[0]));
            int padRight = Math.max(0, lastInsetRight);

            if (rootContainer.getPaddingLeft() != padLeft
                    || rootContainer.getPaddingTop() != padTop
                    || rootContainer.getPaddingRight() != padRight
                    || rootContainer.getPaddingBottom() != padBottom) {
                rootContainer.setPadding(padLeft, padTop, padRight, padBottom);
                rootContainer.invalidate();
            }
            syncSafeAreaToWeb();
        } catch (Exception ignored) {
        }
    }

    private void syncSafeAreaToWeb() {
        if (webView == null) return;
        try {
            webView.evaluateJavascript(
                    "try{var r=document.documentElement.style;r.setProperty('--safe-top','0px');r.setProperty('--safe-bottom','0px');r.setProperty('--safe-left','0px');r.setProperty('--safe-right','0px');}catch(e){}",
                    null
            );
        } catch (Exception ignored) {
        }
    }

    private void setupMediaSessionAndNotificationChannel() {
        try {
            notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
                NotificationChannel ch = new NotificationChannel(
                        MEDIA_CHANNEL_ID,
                        "PC Medya ve Oynatma Kontrolü",
                        NotificationManager.IMPORTANCE_LOW
                );
                ch.setDescription("Bilgisayarda oynatılan medyayı bildirim çubuğundan kontrol etmenizi sağlar.");
                ch.setShowBadge(false);
                ch.enableVibration(false);
                ch.setSound(null, null);
                notificationManager.createNotificationChannel(ch);

                NotificationChannel quickCh = new NotificationChannel(
                        QUICK_CHANNEL_ID,
                        "PC Hızlı Kontrol Kısayolları",
                        NotificationManager.IMPORTANCE_LOW
                );
                quickCh.setDescription("Ekran açma/karartma, kilitleme, uyku ve kapatma hızlı kısayolları.");
                quickCh.setShowBadge(false);
                quickCh.enableVibration(false);
                quickCh.setSound(null, null);
                notificationManager.createNotificationChannel(quickCh);
            }

            mediaSession = new MediaSession(this, "BridgeMedia");
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    dispatchMediaKeyToWeb("MEDIA_PLAY_PAUSE");
                }

                @Override
                public void onPause() {
                    dispatchMediaKeyToWeb("MEDIA_PLAY_PAUSE");
                }

                @Override
                public void onSkipToNext() {
                    dispatchMediaKeyToWeb("MEDIA_NEXT");
                }

                @Override
                public void onSkipToPrevious() {
                    dispatchMediaKeyToWeb("MEDIA_PREV");
                }

                @Override
                public void onStop() {
                    dismissMediaNotificationForCurrentTrack();
                }

                @Override
                public void onSeekTo(long pos) {
                    long sec = Math.max(0L, Math.round(pos / 1000.0));
                    dispatchMediaSeekToWeb(sec);
                }
            });

            IntentFilter filter = new IntentFilter();
            filter.addAction(ACTION_MEDIA_PREV);
            filter.addAction(ACTION_MEDIA_PLAY_PAUSE);
            filter.addAction(ACTION_MEDIA_NEXT);
            filter.addAction(ACTION_MEDIA_MUTE);
            filter.addAction(ACTION_MEDIA_DISMISSED);

            mediaReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (intent == null || intent.getAction() == null) return;
                    String act = intent.getAction();
                    if (ACTION_MEDIA_PREV.equals(act)) {
                        dispatchMediaKeyToWeb("MEDIA_PREV");
                    } else if (ACTION_MEDIA_PLAY_PAUSE.equals(act)) {
                        dispatchMediaKeyToWeb("MEDIA_PLAY_PAUSE");
                    } else if (ACTION_MEDIA_NEXT.equals(act)) {
                        dispatchMediaKeyToWeb("MEDIA_NEXT");
                    } else if (ACTION_MEDIA_MUTE.equals(act)) {
                        dispatchMediaKeyToWeb("VOLUME_MUTE");
                    } else if (ACTION_MEDIA_DISMISSED.equals(act)) {
                        dismissMediaNotificationForCurrentTrack();
                    }
                }
            };

            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(mediaReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(mediaReceiver, filter);
            }

            try {
                updateMultiDeviceQsTileSlots(this, 1);
            } catch (Exception ignored) {
            }
            promptUninstallLegacyPackageIfPresent();
        } catch (Exception ignored) {
        }
    }

    private void promptUninstallLegacyPackageIfPresent() {
        try {
            android.content.pm.PackageManager pm = getPackageManager();
            if (pm != null) {
                pm.getPackageInfo("com.tahablt.connect", 0);
                // Legacy package "com.tahablt.connect" (TahaBLT Connect) is still installed alongside Bridge,
                // which causes duplicate Quick Settings tiles in the system panel. Prompt user to remove it.
                android.widget.Toast.makeText(
                        this,
                        "Çift kısayolları temizlemek için eski 'TahaBLT Connect' uygulamasını kaldırın.",
                        android.widget.Toast.LENGTH_LONG
                ).show();
                Intent uninstallIntent = new Intent(Intent.ACTION_DELETE);
                uninstallIntent.setData(android.net.Uri.parse("package:com.tahablt.connect"));
                uninstallIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(uninstallIntent);
            }
        } catch (Exception ignored) {
            // Package not installed; nothing to clean up
        }
    }

    public void dismissMediaNotificationForCurrentTrack() {
        runOnUiThread(() -> {
            try {
                if (currentMediaTrackKey != null && !currentMediaTrackKey.isEmpty()) {
                    dismissedMediaTrackKey = currentMediaTrackKey;
                } else {
                    dismissedMediaTrackKey = "__DISMISSED__";
                }
                lastMediaJson = "";
                if (mediaSession != null) mediaSession.setActive(false);
                if (notificationManager != null) notificationManager.cancel(MEDIA_NOTIFICATION_ID);
            } catch (Exception ignored) {
            }
        });
    }

    public void dispatchMediaSeekToWeb(final long positionSec) {
        if (webView == null) return;
        runOnUiThread(() -> {
            try {
                if (lastMediaJson != null && !lastMediaJson.isEmpty()) {
                    try {
                        JSONObject currentObj = new JSONObject(lastMediaJson);
                        if (currentObj.optBoolean("active", false)) {
                            currentObj.put("positionSec", positionSec);
                            updatePcMediaNotificationInternal(currentObj.toString());
                        }
                    } catch (Exception ignored) {
                    }
                }
                webView.evaluateJavascript(
                        "if(window.__onAndroidMediaSeek) window.__onAndroidMediaSeek(" + positionSec + ");",
                        null
                );
            } catch (Exception ignored) {
            }
        });
    }

    public void dispatchMediaKeyToWeb(final String keyName) {
        if (webView == null || keyName == null) return;
        runOnUiThread(() -> {
            try {
                if ("MEDIA_PLAY_PAUSE".equals(keyName) && lastMediaJson != null && !lastMediaJson.isEmpty()) {
                    try {
                        JSONObject currentObj = new JSONObject(lastMediaJson);
                        if (currentObj.optBoolean("active", false)) {
                            boolean currPlaying = currentObj.optBoolean("isPlaying", true);
                            currentObj.put("isPlaying", !currPlaying);
                            updatePcMediaNotificationInternal(currentObj.toString());
                        }
                    } catch (Exception ignored) {
                    }
                }
                webView.evaluateJavascript(
                        "if(window.__onAndroidMediaAction) window.__onAndroidMediaAction('" + keyName + "');",
                        null
                );
            } catch (Exception ignored) {
            }
        });
    }

    public void updatePcMediaNotificationInternal(final String jsonStr) {
        runOnUiThread(() -> {
            try {
                if (notificationManager == null || mediaSession == null) return;
                if (!mediaNotificationEnabled || jsonStr == null || jsonStr.trim().isEmpty()) {
                    lastMediaJson = "";
                    mediaSession.setActive(false);
                    notificationManager.cancel(MEDIA_NOTIFICATION_ID);
                    return;
                }

                JSONObject obj = new JSONObject(jsonStr);
                boolean active = obj.optBoolean("active", false);
                if (!active) {
                    lastMediaJson = "";
                    currentMediaTrackKey = "";
                    dismissedMediaTrackKey = "";
                    mediaSession.setActive(false);
                    notificationManager.cancel(MEDIA_NOTIFICATION_ID);
                    return;
                }

                boolean isPlaying = obj.optBoolean("isPlaying", true);
                String title = obj.optString("title", "Medya Oynatılıyor").trim();
                String appName = obj.optString("appName", "Bilgisayar").trim();
                String trackKey = title + "|" + appName;
                currentMediaTrackKey = trackKey;

                // If user swiped away / closed the media player in the notification panel for this track, do not re-post it
                if (!dismissedMediaTrackKey.isEmpty()) {
                    if (dismissedMediaTrackKey.equals(trackKey) || dismissedMediaTrackKey.equals("__DISMISSED__")) {
                        dismissedMediaTrackKey = trackKey;
                        mediaSession.setActive(false);
                        notificationManager.cancel(MEDIA_NOTIFICATION_ID);
                        return;
                    } else {
                        // A brand new track started playing
                        dismissedMediaTrackKey = "";
                    }
                }

                lastMediaJson = jsonStr;
                String deviceName = obj.optString("deviceName", "PC").trim();
                String iconDataUrl = obj.optString("icon", "");
                long positionMs = Math.max(0L, obj.optLong("positionSec", 0L) * 1000L);
                long durationMs = Math.max(0L, obj.optLong("durationSec", 0L) * 1000L);

                String statusLabel = isPlaying ? "Oynatılıyor" : "Duraklatıldı";
                String subtitle = statusLabel + " · " + (appName.isEmpty() ? deviceName : (appName + " · " + deviceName));

                Bitmap artBmp = null;
                if (iconDataUrl != null && iconDataUrl.startsWith("data:image/")) {
                    int comma = iconDataUrl.indexOf(',');
                    if (comma > 0) {
                        byte[] raw = Base64.decode(iconDataUrl.substring(comma + 1), Base64.DEFAULT);
                        artBmp = BitmapFactory.decodeByteArray(raw, 0, raw.length);
                    }
                }

                MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                        .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                        .putString(MediaMetadata.METADATA_KEY_ALBUM, statusLabel + " · " + deviceName);
                if (durationMs > 0L) {
                    metaBuilder.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
                }
                if (artBmp != null) {
                    metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artBmp);
                    metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, artBmp);
                }
                mediaSession.setMetadata(metaBuilder.build());

                long actions = PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_SEEK_TO;

                PlaybackState state = new PlaybackState.Builder()
                        .setActions(actions)
                        .setState(
                                isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                                positionMs,
                                isPlaying ? 1.0f : 0.0f
                        )
                        .build();
                mediaSession.setPlaybackState(state);
                mediaSession.setActive(true);

                int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    piFlags |= PendingIntent.FLAG_IMMUTABLE;
                }

                Intent openIntent = new Intent(this, MainActivity.class);
                openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent contentPi = PendingIntent.getActivity(this, 10, openIntent, piFlags);

                PendingIntent prevPi = PendingIntent.getBroadcast(
                        this, 11, new Intent(ACTION_MEDIA_PREV).setPackage(getPackageName()), piFlags);
                PendingIntent playPausePi = PendingIntent.getBroadcast(
                        this, 12, new Intent(ACTION_MEDIA_PLAY_PAUSE).setPackage(getPackageName()), piFlags);
                PendingIntent nextPi = PendingIntent.getBroadcast(
                        this, 13, new Intent(ACTION_MEDIA_NEXT).setPackage(getPackageName()), piFlags);
                PendingIntent mutePi = PendingIntent.getBroadcast(
                        this, 14, new Intent(ACTION_MEDIA_MUTE).setPackage(getPackageName()), piFlags);
                PendingIntent dismissPi = PendingIntent.getBroadcast(
                        this, 15, new Intent(ACTION_MEDIA_DISMISSED).setPackage(getPackageName()), piFlags);

                Notification.Builder nb;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    nb = new Notification.Builder(this, MEDIA_CHANNEL_ID);
                } else {
                    nb = new Notification.Builder(this);
                }

                nb.setSmallIcon(isPlaying ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
                        .setContentTitle(title)
                        .setContentText(subtitle)
                        .setSubText(statusLabel)
                        .setContentIntent(contentPi)
                        .setDeleteIntent(dismissPi)
                        .setVisibility(Notification.VISIBILITY_PUBLIC)
                        .setOngoing(false)
                        .setShowWhen(false)
                        .setColor(Color.parseColor("#18181B"));

                if (artBmp != null) {
                    nb.setLargeIcon(artBmp);
                }

                nb.addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_previous, "Önceki", prevPi).build());
                nb.addAction(new Notification.Action.Builder(
                        isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        isPlaying ? "Duraklat" : "Oynat",
                        playPausePi).build());
                nb.addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_next, "Sonraki", nextPi).build());
                nb.addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_lock_silent_mode, "Sessiz", mutePi).build());

                Notification.MediaStyle style = new Notification.MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2);
                nb.setStyle(style);

                notificationManager.notify(MEDIA_NOTIFICATION_ID, nb.build());
            } catch (Exception ignored) {
            }
        });
    }

    public void updateQuickControlNotificationFromPrefs() {
        runOnUiThread(() -> {
            try {
                if (notificationManager != null) {
                    notificationManager.cancel(QUICK_NOTIFICATION_ID);
                }
            } catch (Exception ignored) {
            }
        });
    }

    public static JSONObject getDeviceForSlot(Context context, int slotIndex) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
            String allRaw = prefs.getString(QUICK_PREFS_ALL_DEVICES_KEY, "");
            if (slotIndex >= 0) {
                if (allRaw != null && !allRaw.isEmpty()) {
                    JSONArray arr = new JSONArray(allRaw);
                    if (slotIndex < arr.length()) {
                        JSONObject d = arr.optJSONObject(slotIndex);
                        if (d != null) return d;
                    }
                    if (slotIndex >= 1) {
                        return null;
                    }
                }
            }
            String raw = prefs.getString(QUICK_PREFS_DEVICE_KEY, "");
            if (raw != null && !raw.isEmpty()) {
                return new JSONObject(raw);
            }
            // Fallback to first saved device in all_devices_json if active_device_json is not yet populated
            if (allRaw != null && !allRaw.isEmpty()) {
                JSONArray arr = new JSONArray(allRaw);
                if (arr.length() > 0) {
                    JSONObject first = arr.optJSONObject(0);
                    if (first != null) return first;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    public static String getDeviceIdForSlot(Context context, int slotIndex) {
        try {
            JSONObject d = getDeviceForSlot(context, slotIndex);
            if (d != null) {
                return d.optString("deviceId", "").trim();
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    public static boolean isDeviceLockedForSlot(Context context, int slotIndex) {
        try {
            JSONObject d = getDeviceForSlot(context, slotIndex);
            if (d == null) return false;
            String devId = d.optString("deviceId", "").trim();
            SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
            if (!devId.isEmpty() && prefs.contains("device_locked_" + devId)) {
                return prefs.getBoolean("device_locked_" + devId, false);
            }
            return d.optBoolean("isLocked", false);
        } catch (Exception ignored) {
        }
        return false;
    }

    public static void setDeviceLockedForId(Context context, String deviceId, boolean isLocked) {
        if (context == null || deviceId == null || deviceId.trim().isEmpty()) return;
        try {
            String cleanId = deviceId.trim();
            SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            editor.putBoolean("device_locked_" + cleanId, isLocked);

            String activeRaw = prefs.getString(QUICK_PREFS_DEVICE_KEY, "");
            if (activeRaw != null && !activeRaw.isEmpty()) {
                try {
                    JSONObject actObj = new JSONObject(activeRaw);
                    if (cleanId.equals(actObj.optString("deviceId", "").trim())) {
                        actObj.put("isLocked", isLocked);
                        editor.putString(QUICK_PREFS_DEVICE_KEY, actObj.toString());
                    }
                } catch (Exception ignored) {
                }
            }

            String allRaw = prefs.getString(QUICK_PREFS_ALL_DEVICES_KEY, "");
            if (allRaw != null && !allRaw.isEmpty()) {
                try {
                    JSONArray arr = new JSONArray(allRaw);
                    boolean changed = false;
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item != null && cleanId.equals(item.optString("deviceId", "").trim())) {
                            item.put("isLocked", isLocked);
                            changed = true;
                        }
                    }
                    if (changed) {
                        editor.putString(QUICK_PREFS_ALL_DEVICES_KEY, arr.toString());
                    }
                } catch (Exception ignored) {
                }
            }

            editor.apply();
            updateMultiDeviceQsTileSlots(context, -1);
        } catch (Exception ignored) {
        }
    }

    public static void queryDeviceLockStateAsync(final Context context, final int slotIndex, final Runnable onUpdated) {
        if (context == null) return;
        QUICK_ACTION_EXECUTOR.submit(() -> {
            try {
                JSONObject dev = getDeviceForSlot(context, slotIndex);
                if (dev == null) return;
                final String targetDevId = dev.optString("deviceId", "").trim();
                String authToken = dev.optString("authToken", "").trim();
                String pin = dev.optString("pin", dev.optString("pairCode", "")).trim();
                if (targetDevId.isEmpty() || (authToken.isEmpty() && pin.isEmpty())) return;

                JSONObject cmdObj = new JSONObject();
                cmdObj.put("action", "get_full_state");
                cmdObj.put("expectedDeviceId", targetDevId);
                if (!authToken.isEmpty()) cmdObj.put("authToken", authToken);
                if (!pin.isEmpty()) cmdObj.put("pin", pin);
                cmdObj.put("params", new JSONObject());
                final String bodyJson = cmdObj.toString();

                List<String> urls = new ArrayList<>();
                String lanIp = dev.optString("lanIp", "").trim();
                if (!lanIp.isEmpty() && !"-".equals(lanIp)) {
                    urls.add("http://" + lanIp + ":4850/api/command");
                }
                JSONArray lanIps = dev.optJSONArray("lanIps");
                if (lanIps != null) {
                    for (int i = 0; i < lanIps.length(); i++) {
                        String ip = lanIps.optString(i, "").trim();
                        if (!ip.isEmpty() && !"-".equals(ip)) {
                            String u = "http://" + ip + ":4850/api/command";
                            if (!urls.contains(u)) urls.add(u);
                        }
                    }
                }
                String tsIp = dev.optString("tailscaleIp", "").trim();
                if (!tsIp.isEmpty() && !"-".equals(tsIp)) {
                    String u = "http://" + tsIp + ":4850/api/command";
                    if (!urls.contains(u)) urls.add(u);
                }
                String tunnelUrl = dev.optString("tunnelUrl", "").trim();
                if (tunnelUrl.startsWith("http")) {
                    String cleanT = tunnelUrl.endsWith("/") ? tunnelUrl.substring(0, tunnelUrl.length() - 1) : tunnelUrl;
                    String u = cleanT + "/api/command";
                    if (!urls.contains(u)) urls.add(u);
                }

                for (String u : urls) {
                    int tMs = u.startsWith("https://") ? 2800 : 950;
                    String res = postJsonStatic(u, bodyJson, tMs);
                    if (res != null && res.contains("\"ok\":true")) {
                        JSONObject root = new JSONObject(res);
                        JSONObject data = root.optJSONObject("data");
                        if (data != null) {
                            JSONObject stats = data.optJSONObject("stats");
                            if (stats != null && stats.has("isLocked")) {
                                final boolean liveLocked = stats.optBoolean("isLocked", false);
                                setDeviceLockedForId(context, targetDevId, liveLocked);
                                if (onUpdated != null) {
                                    new android.os.Handler(android.os.Looper.getMainLooper()).post(onUpdated);
                                }
                                final MainActivity inst = currentInstance;
                                if (inst != null && inst.webView != null) {
                                    inst.runOnUiThread(() -> {
                                        try {
                                            inst.webView.evaluateJavascript(
                                                    "if(window.__onNativeDeviceLockUpdated) window.__onNativeDeviceLockUpdated("
                                                            + JSONObject.quote(targetDevId) + ","
                                                            + (liveLocked ? "true" : "false") + ");",
                                                    null
                                            );
                                        } catch (Exception ignored) {
                                        }
                                    });
                                }
                            }
                        }
                        break;
                    }
                }
            } catch (Exception ignored) {
            }
        });
    }

    public static String getShortDeviceNameForSlot(Context context, int slotIndex) {
        try {
            JSONObject d = getDeviceForSlot(context, slotIndex);
            if (d != null) {
                String name = d.optString("deviceName", "").trim();
                if (name.isEmpty()) name = d.optString("name", "").trim();
                if (name.isEmpty()) name = d.optString("lanIp", "").trim();
                if (!name.isEmpty() && !"-".equals(name)) return name;
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    public static void cycleActiveQuickDevice(Context context) {
        try {
            Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(14, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(14);
                }
            }
            SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
            String allRaw = prefs.getString(QUICK_PREFS_ALL_DEVICES_KEY, "");
            if (allRaw == null || allRaw.isEmpty()) return;
            JSONArray arr = new JSONArray(allRaw);
            if (arr.length() <= 1) return;

            String curId = "";
            String curRaw = prefs.getString(QUICK_PREFS_DEVICE_KEY, "");
            if (curRaw != null && !curRaw.isEmpty()) {
                curId = new JSONObject(curRaw).optString("deviceId", "");
            }

            int nextIdx = 0;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null && curId.equals(item.optString("deviceId", ""))) {
                    nextIdx = (i + 1) % arr.length();
                    break;
                }
            }
            JSONObject nextDev = arr.optJSONObject(nextIdx);
            if (nextDev != null) {
                prefs.edit().putString(QUICK_PREFS_DEVICE_KEY, nextDev.toString()).apply();
                final String nextId = nextDev.optString("deviceId", "");
                final MainActivity inst = currentInstance;
                if (inst != null && inst.webView != null && !nextId.isEmpty()) {
                    inst.runOnUiThread(() -> {
                        try {
                            inst.webView.evaluateJavascript(
                                    "if(window.__onNativeActiveDeviceCycled) window.__onNativeActiveDeviceCycled("
                                            + JSONObject.quote(nextId) + ");",
                                    null
                            );
                        } catch (Exception ignored) {
                        }
                    });
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static void updateMultiDeviceQsTileSlots(Context context, int deviceCount) {
        try {
            int count = deviceCount;
            if (count < 0) {
                SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
                String allRaw = prefs.getString(QUICK_PREFS_ALL_DEVICES_KEY, "");
                if (allRaw != null && !allRaw.isEmpty()) {
                    try {
                        count = new JSONArray(allRaw).length();
                    } catch (Exception ignored) {
                        count = 1;
                    }
                } else {
                    count = 1;
                }
            }

            try {
                android.content.pm.PackageManager pm = context.getPackageManager();
                android.content.ComponentName lock2Comp = new android.content.ComponentName(context, QsLockTileService2.class);
                int desiredState = count >= 2
                        ? android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                        : android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
                if (pm.getComponentEnabledSetting(lock2Comp) != desiredState) {
                    pm.setComponentEnabledSetting(
                            lock2Comp,
                            desiredState,
                            android.content.pm.PackageManager.DONT_KILL_APP
                    );
                }
            } catch (Exception ignored) {
            }

            Class<?>[] tileClasses = new Class<?>[]{
                    QsMonitorsOnTileService.class,
                    QsMonitorsOffTileService.class,
                    QsLockTileService.class,
                    QsLockTileService2.class,
                    QsSleepTileService.class,
                    QsShutdownTileService.class
            };
            for (Class<?> cls : tileClasses) {
                try {
                    android.service.quicksettings.TileService.requestListeningState(
                            context,
                            new android.content.ComponentName(context, cls)
                    );
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static void executeQuickDeviceAction(final Context context, final String quickAction) {
        executeQuickDeviceActionForSlot(context, quickAction, -1);
    }

    public static void executeQuickDeviceActionForSlot(final Context context, final String quickAction, final int slotIndex) {
        if (context == null || quickAction == null) return;
        try {
            Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(14, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(14);
                }
            }
        } catch (Exception ignored) {
        }

        final String cmdId = "qa_" + System.currentTimeMillis() + "_" + Math.abs((int) (Math.random() * 1000000));
        final JSONObject targetDevObj = getDeviceForSlot(context, slotIndex);
        final String targetDevId = targetDevObj != null ? targetDevObj.optString("deviceId", "").trim() : "";

        // 1. 0ms Instant WebSocket Fast-Path if app WebView is active in memory and connected to the exact target device
        final MainActivity activeInst = currentInstance;
        if (activeInst != null && activeInst.webView != null) {
            activeInst.runOnUiThread(() -> {
                try {
                    activeInst.webView.evaluateJavascript(
                            "if(window.__triggerNativeQuickActionFast) window.__triggerNativeQuickActionFast("
                                    + JSONObject.quote(quickAction) + ","
                                    + JSONObject.quote(cmdId) + ","
                                    + JSONObject.quote(targetDevId) + ");",
                            null
                    );
                } catch (Exception ignored) {
                }
            });
        }

        // 2. Parallel HTTP Race across all LAN / Hotspot / Tailscale / Cloud Tunnel endpoints simultaneously (deduplicated by cmdId on server)
        QUICK_ACTION_EXECUTOR.submit(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject dev = getDeviceForSlot(context, slotIndex);
                if (dev == null) return;
                String authToken = dev.optString("authToken", "").trim();
                String pin = dev.optString("pin", dev.optString("pairCode", "")).trim();
                if (authToken.isEmpty() && pin.isEmpty()) return;

                JSONObject cmdObj = new JSONObject();
                cmdObj.put("cmdId", cmdId);
                if (!targetDevId.isEmpty()) cmdObj.put("expectedDeviceId", targetDevId);
                if (!authToken.isEmpty()) cmdObj.put("authToken", authToken);
                if (!pin.isEmpty()) cmdObj.put("pin", pin);
                JSONObject params = new JSONObject();
                params.put("cmdId", cmdId);
                if ("monitors_on".equals(quickAction)) {
                    cmdObj.put("action", "monitor_power");
                    params.put("action", "on");
                    params.put("clearBlackouts", true);
                } else if ("monitors_off".equals(quickAction)) {
                    cmdObj.put("action", "monitor_power");
                    params.put("action", "off");
                } else if ("toggle_lock".equals(quickAction)) {
                    cmdObj.put("action", "system_control");
                    params.put("action", "toggle_lock");
                } else if ("sleep".equals(quickAction)) {
                    cmdObj.put("action", "system_control");
                    params.put("action", "sleep");
                } else if ("shutdown".equals(quickAction)) {
                    cmdObj.put("action", "system_control");
                    params.put("action", "shutdown");
                } else {
                    return;
                }
                cmdObj.put("params", params);
                final String bodyJson = cmdObj.toString();

                List<String> urls = new ArrayList<>();
                String lanIp = dev.optString("lanIp", "").trim();
                if (!lanIp.isEmpty() && !"-".equals(lanIp)) {
                    urls.add("http://" + lanIp + ":4850/api/command");
                }
                JSONArray lanIps = dev.optJSONArray("lanIps");
                if (lanIps != null) {
                    for (int i = 0; i < lanIps.length(); i++) {
                        String ip = lanIps.optString(i, "").trim();
                        if (!ip.isEmpty() && !"-".equals(ip)) {
                            String u = "http://" + ip + ":4850/api/command";
                            if (!urls.contains(u)) urls.add(u);
                        }
                    }
                }
                String tsIp = dev.optString("tailscaleIp", "").trim();
                if (!tsIp.isEmpty() && !"-".equals(tsIp)) {
                    String u = "http://" + tsIp + ":4850/api/command";
                    if (!urls.contains(u)) urls.add(u);
                }
                String tunnelUrl = dev.optString("tunnelUrl", "").trim();
                if (tunnelUrl.startsWith("http")) {
                    String cleanT = tunnelUrl.endsWith("/") ? tunnelUrl.substring(0, tunnelUrl.length() - 1) : tunnelUrl;
                    String u = cleanT + "/api/command";
                    if (!urls.contains(u)) urls.add(u);
                }

                final java.util.concurrent.atomic.AtomicReference<String> winRef = new java.util.concurrent.atomic.AtomicReference<>(null);
                final java.util.concurrent.CountDownLatch doneLatch = new java.util.concurrent.CountDownLatch(1);
                final java.util.concurrent.atomic.AtomicInteger remaining = new java.util.concurrent.atomic.AtomicInteger(urls.size());

                if (urls.isEmpty()) {
                    doneLatch.countDown();
                } else {
                    for (final String u : urls) {
                        QUICK_ACTION_EXECUTOR.submit(() -> {
                            try {
                                int tMs = u.startsWith("https://") ? 3500 : 1200;
                                String res = postJsonStatic(u, bodyJson, tMs);
                                if (res != null && res.contains("\"ok\":true")) {
                                    if (winRef.compareAndSet(null, res)) {
                                        doneLatch.countDown();
                                    }
                                    return;
                                }
                            } catch (Exception ignored) {
                            } finally {
                                if (remaining.decrementAndGet() <= 0) {
                                    doneLatch.countDown();
                                }
                            }
                        });
                    }
                    doneLatch.await(3600, TimeUnit.MILLISECONDS);
                }

                String successRes = winRef.get();
                if (successRes != null && "toggle_lock".equals(quickAction) && !targetDevId.isEmpty()) {
                    try {
                        JSONObject root = new JSONObject(successRes);
                        JSONObject data = root.optJSONObject("data");
                        if (data != null && data.has("isLocked")) {
                            final boolean actualLocked = data.optBoolean("isLocked", false);
                            setDeviceLockedForId(context, targetDevId, actualLocked);
                            final MainActivity instLock = currentInstance;
                            if (instLock != null && instLock.webView != null) {
                                instLock.runOnUiThread(() -> {
                                    try {
                                        instLock.webView.evaluateJavascript(
                                                "if(window.__onNativeDeviceLockUpdated) window.__onNativeDeviceLockUpdated("
                                                        + JSONObject.quote(targetDevId) + ","
                                                        + (actualLocked ? "true" : "false") + ");",
                                                null
                                        );
                                    } catch (Exception ignored) {
                                    }
                                });
                            }
                        }
                    } catch (Exception ignored) {
                    }
                }

                final String finalRes = successRes != null ? successRes : "";
                final MainActivity inst = currentInstance;
                if (inst != null && inst.webView != null) {
                    inst.runOnUiThread(() -> {
                        try {
                            inst.webView.evaluateJavascript(
                                    "if(window.__onNativeQuickActionResult) window.__onNativeQuickActionResult("
                                            + JSONObject.quote(quickAction) + ","
                                            + JSONObject.quote(finalRes) + ");",
                                    null
                            );
                        } catch (Exception ignored) {
                        }
                    });
                }
            } catch (Exception ignored) {
            }
        });
    }

    private static String postJsonStatic(String urlStr, String jsonBody, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("Connection", "keep-alive");
            byte[] payload = jsonBody.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) return "";
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            return sb.toString();
        } catch (Exception e) {
            if (conn != null) conn.disconnect();
            return "";
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            try {
                webView.onResume();
                webView.resumeTimers();
                webView.evaluateJavascript("if(window.__onNativeAppResume)window.__onNativeAppResume();", null);
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && webView != null) {
            try {
                webView.resumeTimers();
                webView.evaluateJavascript("if(window.__onNativeAppResume)window.__onNativeAppResume();", null);
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (currentInstance == this) {
            currentInstance = null;
        }
        try {
            if (mediaReceiver != null) unregisterReceiver(mediaReceiver);
        } catch (Exception ignored) {
        }
        try {
            if (mediaSession != null) {
                mediaSession.setActive(false);
                mediaSession.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (notificationManager != null) {
                notificationManager.cancel(MEDIA_NOTIFICATION_ID);
            }
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){ if(window.__handleAndroidBack && window.__handleAndroidBack()) return 'HANDLED'; return 'DEFAULT'; })()",
                    value -> {
                        if (value == null || !value.contains("HANDLED")) {
                            MainActivity.super.onBackPressed();
                        }
                    }
            );
        } else {
            super.onBackPressed();
        }
    }

    public static class NativeBridge {
        private final MainActivity activity;
        private final Context context;

        public NativeBridge(MainActivity activity) {
            this.activity = activity;
            this.context = activity;
        }

        @JavascriptInterface
        public void syncActiveDeviceForQuickControls(final String deviceJson) {
            try {
                SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(QUICK_PREFS_DEVICE_KEY, deviceJson != null ? deviceJson : "").apply();
                if (deviceJson != null && !deviceJson.isEmpty()) {
                    JSONObject obj = new JSONObject(deviceJson);
                    String devId = obj.optString("deviceId", "").trim();
                    if (!devId.isEmpty() && obj.has("isLocked")) {
                        prefs.edit().putBoolean("device_locked_" + devId, obj.optBoolean("isLocked", false)).apply();
                    }
                }
                updateMultiDeviceQsTileSlots(context, -1);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void syncDeviceLockState(final String deviceId, final boolean isLocked) {
            try {
                setDeviceLockedForId(context, deviceId, isLocked);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void syncAllDevicesForQuickControls(final String allDevicesJson) {
            try {
                String safeJson = allDevicesJson != null ? allDevicesJson : "[]";
                SharedPreferences prefs = context.getSharedPreferences(QUICK_PREFS_NAME, Context.MODE_PRIVATE);
                SharedPreferences.Editor ed = prefs.edit();
                ed.putString(QUICK_PREFS_ALL_DEVICES_KEY, safeJson);
                JSONArray arr = new JSONArray(safeJson);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) {
                        String id = item.optString("deviceId", "").trim();
                        if (!id.isEmpty() && item.has("isLocked")) {
                            ed.putBoolean("device_locked_" + id, item.optBoolean("isLocked", false));
                        }
                    }
                }
                ed.apply();
                updateMultiDeviceQsTileSlots(context, arr.length());
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void updateMediaNotification(final String jsonPayload) {
            if (activity != null) {
                activity.updatePcMediaNotificationInternal(jsonPayload);
            }
        }

        @JavascriptInterface
        public void clearMediaNotification() {
            if (activity != null) {
                activity.updatePcMediaNotificationInternal("");
            }
        }

        @JavascriptInterface
        public void setMediaNotificationEnabled(final boolean enabled) {
            if (activity != null) {
                activity.mediaNotificationEnabled = enabled;
                if (enabled) {
                    activity.dismissedMediaTrackKey = "";
                } else {
                    activity.updatePcMediaNotificationInternal("");
                }
            }
        }

        @JavascriptInterface
        public void setLandscapeFullscreen(final boolean fullscreen) {
            if (activity == null) return;
            activity.runOnUiThread(() -> {
                try {
                    activity.isLandscapeFullscreen = fullscreen;
                    Window w = activity.getWindow();
                    View decor = w.getDecorView();
                    if (fullscreen) {
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        decor.setSystemUiVisibility(
                                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        );
                    } else {
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                        w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                    }
                    activity.applyCalculatedSafePadding();
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void setNavBarColor(final String hexColor) {
            if (activity == null || hexColor == null) return;
            activity.runOnUiThread(() -> {
                try {
                    Window w = activity.getWindow();
                    int c = Color.parseColor(hexColor);
                    activity.currentNavBarColor = c;
                    w.setNavigationBarColor(c);
                    if (Build.VERSION.SDK_INT >= 28) {
                        w.setNavigationBarDividerColor(c);
                    }
                    if (Build.VERSION.SDK_INT >= 29) {
                        w.setNavigationBarContrastEnforced(false);
                    }
                    if (activity.rootContainer != null) {
                        activity.rootContainer.invalidate();
                    }
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void haptic(int durationMs) {
            try {
                Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) {
                    int ms = Math.max(5, Math.min(80, durationMs));
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        v.vibrate(ms);
                    }
                }
            } catch (Exception ignored) {
            }
        }

        private void dispatchCallbackToJs(final String cbId, final String payloadJson) {
            if (activity == null || activity.webView == null || cbId == null) return;
            final String safePayload = payloadJson != null ? payloadJson : "";
            activity.runOnUiThread(() -> {
                try {
                    activity.webView.evaluateJavascript(
                            "if(window.__onNativeAsyncCallback)window.__onNativeAsyncCallback("
                                    + JSONObject.quote(cbId) + ","
                                    + JSONObject.quote(safePayload) + ");",
                            null
                    );
                } catch (Exception ignored) {
                }
            });
        }

        private String httpPostInternal(String urlStr, String jsonBody, int connectTimeoutMs, int readTimeoutMs) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(Math.max(400, connectTimeoutMs));
                conn.setReadTimeout(Math.max(500, readTimeoutMs));
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

                byte[] payload = (jsonBody != null ? jsonBody : "{}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                }

                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (is == null) return "{\"ok\":false,\"httpStatus\":" + code + ",\"error\":\"Sunucu yanıt vermedi\"}";
                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();
                return sb.toString();
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @JavascriptInterface
        public String httpPost(String urlStr, String jsonBody) {
            return httpPostInternal(urlStr, jsonBody, 1600, 1800);
        }

        @JavascriptInterface
        public void httpPostAsync(final String cbId, final String urlStr, final String jsonBody, final int timeoutMs) {
            final int tMs = timeoutMs > 0 ? timeoutMs : 1800;
            new Thread(() -> {
                String res = httpPostInternal(urlStr, jsonBody, tMs, tMs + 400);
                dispatchCallbackToJs(cbId, res);
            }).start();
        }

        private String httpGetInternal(String urlStr, int timeoutMs) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(Math.max(500, timeoutMs));
                conn.setReadTimeout(Math.max(500, timeoutMs));
                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (is == null) return "";
                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line).append("\n");
                reader.close();
                return sb.toString().trim();
            } catch (Exception e) {
                return "";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @JavascriptInterface
        public String httpGet(String urlStr) {
            return httpGetInternal(urlStr, 2200);
        }

        @JavascriptInterface
        public void httpGetAsync(final String cbId, final String urlStr, final int timeoutMs) {
            final int tMs = timeoutMs > 0 ? timeoutMs : 2200;
            new Thread(() -> {
                String res = httpGetInternal(urlStr, tMs);
                dispatchCallbackToJs(cbId, res);
            }).start();
        }

        private List<InetAddress> getLocalBroadcastAddresses() {
            List<InetAddress> list = new ArrayList<>();
            try {
                list.add(InetAddress.getByName("255.255.255.255"));
                Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
                if (interfaces != null) {
                    for (NetworkInterface ni : Collections.list(interfaces)) {
                        if (ni.isLoopback() || !ni.isUp()) continue;
                        for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                            InetAddress bcast = ia.getBroadcast();
                            if (bcast != null && !list.contains(bcast)) {
                                list.add(bcast);
                            }
                        }
                    }
                }
                // Also include standard Home Router & Android USB Tethering & Wi-Fi Hotspot subnet broadcast addresses
                String[] commonBcasts = new String[]{"192.168.1.255", "192.168.0.255", "192.168.42.255", "192.168.43.255", "192.168.137.255"};
                for (String tb : commonBcasts) {
                    try {
                        InetAddress a = InetAddress.getByName(tb);
                        if (!list.contains(a)) list.add(a);
                    } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {
            }
            return list;
        }

        private String discoverDevicesInternal(boolean includeTcpScan) {
            JSONArray results = new JSONArray();
            Set<String> seenIds = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
            List<JSONObject> foundList = Collections.synchronizedList(new ArrayList<JSONObject>());

            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(160);

                byte[] sendData = "TAHABLT_DISCOVER".getBytes(StandardCharsets.UTF_8);
                List<InetAddress> bcasts = getLocalBroadcastAddresses();
                for (int burst = 0; burst < 2; burst++) {
                    for (InetAddress bcastAddr : bcasts) {
                        try {
                            DatagramPacket sendPacket = new DatagramPacket(sendData, sendData.length, bcastAddr, 4851);
                            socket.send(sendPacket);
                        } catch (Exception ignored) {
                        }
                    }
                    long waitUntil = System.currentTimeMillis() + (burst == 0 ? 140 : 200);
                    byte[] recvBuf = new byte[2048];
                    while (System.currentTimeMillis() < waitUntil) {
                        try {
                            DatagramPacket recvPacket = new DatagramPacket(recvBuf, recvBuf.length);
                            socket.receive(recvPacket);
                            String text = new String(recvPacket.getData(), 0, recvPacket.getLength(), StandardCharsets.UTF_8);
                            JSONObject obj = new JSONObject(text);
                            String devId = obj.optString("deviceId", "");
                            if (!devId.isEmpty() && seenIds.add(devId)) {
                                foundList.add(obj);
                            }
                        } catch (SocketTimeoutException ste) {
                            break;
                        }
                    }
                    if (!foundList.isEmpty()) break;
                }
            } catch (Exception ignored) {
            } finally {
                if (socket != null) socket.close();
            }

            for (JSONObject item : foundList) {
                results.put(item);
            }
            return results.toString();
        }

        @JavascriptInterface
        public String discoverDevices() {
            // Fast non-stalling UDP-only check if called synchronously
            return discoverDevicesInternal(false);
        }

        @JavascriptInterface
        public void discoverDevicesAsync(final String cbId) {
            new Thread(() -> {
                String res = discoverDevicesInternal(true);
                dispatchCallbackToJs(cbId, res);
            }).start();
        }

        @JavascriptInterface
        public String getAppVersion() {
            try {
                android.content.pm.PackageInfo pInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
                if (pInfo != null && pInfo.versionName != null) {
                    return pInfo.versionName;
                }
            } catch (Exception ignored) {
            }
            return "2.17.0";
        }

        @JavascriptInterface
        public void downloadAndInstallApk(final String apkUrl) {
            final String targetUrl = (apkUrl != null && !apkUrl.trim().isEmpty())
                    ? apkUrl.trim()
                    : "https://github.com/blttaha/bridge/releases/latest/download/Bridge.apk";

            new Thread(() -> {
                try {
                    if (activity != null) {
                        activity.runOnUiThread(() -> {
                            try {
                                android.widget.Toast.makeText(context, "Bridge güncellemesi indiriliyor...", android.widget.Toast.LENGTH_SHORT).show();
                                if (activity.webView != null) {
                                    activity.webView.evaluateJavascript("if(window.onApkUpdateStatus)window.onApkUpdateStatus('downloading', 10);", null);
                                }
                            } catch (Exception ignored) {}
                        });
                    }

                    String currentUrl = targetUrl;
                    HttpURLConnection conn = null;
                    for (int redirects = 0; redirects < 6; redirects++) {
                        conn = (HttpURLConnection) new URL(currentUrl).openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(10000);
                        conn.setReadTimeout(25000);
                        conn.setRequestProperty("User-Agent", "Bridge-Android-Updater/2.17.0");
                        int status = conn.getResponseCode();
                        if (status == HttpURLConnection.HTTP_MOVED_TEMP
                                || status == HttpURLConnection.HTTP_MOVED_PERM
                                || status == HttpURLConnection.HTTP_SEE_OTHER
                                || status == 307
                                || status == 308) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (loc == null || loc.isEmpty()) break;
                            currentUrl = new URL(new URL(currentUrl), loc).toString();
                            continue;
                        }
                        break;
                    }

                    if (conn == null || conn.getResponseCode() != 200) {
                        throw new Exception("HTTP " + (conn != null ? conn.getResponseCode() : 0));
                    }

                    int totalBytes = conn.getContentLength();
                    java.io.File cacheDir = context.getExternalCacheDir() != null ? context.getExternalCacheDir() : context.getCacheDir();
                    java.io.File outFile = new java.io.File(cacheDir, "Bridge-Update.apk");
                    if (outFile.exists()) outFile.delete();

                    try (InputStream in = conn.getInputStream();
                         java.io.FileOutputStream out = new java.io.FileOutputStream(outFile)) {
                        byte[] buf = new byte[16384];
                        int read;
                        long downloaded = 0;
                        int lastPct = 0;
                        while ((read = in.read(buf)) != -1) {
                            out.write(buf, 0, read);
                            downloaded += read;
                            if (totalBytes > 0) {
                                final int pct = (int) Math.min(99L, (downloaded * 100L) / totalBytes);
                                if (pct >= lastPct + 10) {
                                    lastPct = pct;
                                    if (activity != null) {
                                        activity.runOnUiThread(() -> {
                                            if (activity.webView != null) {
                                                activity.webView.evaluateJavascript("if(window.onApkUpdateStatus)window.onApkUpdateStatus('downloading', " + pct + ");", null);
                                            }
                                        });
                                    }
                                }
                            }
                        }
                        out.flush();
                    }

                    if (activity != null) {
                        activity.runOnUiThread(() -> {
                            try {
                                if (activity.webView != null) {
                                    activity.webView.evaluateJavascript("if(window.onApkUpdateStatus)window.onApkUpdateStatus('installing', 100);", null);
                                }
                                android.net.Uri apkUri = android.net.Uri.parse("content://" + ApkProvider.AUTHORITY + "/Bridge-Update.apk");
                                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                                context.startActivity(installIntent);
                            } catch (Exception e) {
                                try {
                                    Intent browserIntent = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(targetUrl));
                                    browserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                    context.startActivity(browserIntent);
                                } catch (Exception ignored) {}
                            }
                        });
                    }
                } catch (final Exception ex) {
                    if (activity != null) {
                        activity.runOnUiThread(() -> {
                            try {
                                if (activity.webView != null) {
                                    activity.webView.evaluateJavascript("if(window.onApkUpdateStatus)window.onApkUpdateStatus('error', 0);", null);
                                }
                                android.widget.Toast.makeText(context, "Güncelleme indirilemedi: " + ex.getMessage(), android.widget.Toast.LENGTH_LONG).show();
                            } catch (Exception ignored) {}
                        });
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public boolean saveBase64File(final String fileName, final String base64Data) {
            if (fileName == null || base64Data == null || base64Data.isEmpty()) return false;
            new Thread(() -> {
                try {
                    String cleanName = new java.io.File(fileName).getName().replaceAll("[\\\\/:*?\"<>|]", "_");
                    int commaIdx = base64Data.indexOf(',');
                    String cleanB64 = commaIdx >= 0 ? base64Data.substring(commaIdx + 1) : base64Data;
                    byte[] bytes = Base64.decode(cleanB64, Base64.DEFAULT);

                    if (Build.VERSION.SDK_INT >= 29) {
                        android.content.ContentValues values = new android.content.ContentValues();
                        values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, cleanName);
                        values.put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                        values.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);
                        android.content.ContentResolver resolver = context.getContentResolver();
                        android.net.Uri itemUri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (itemUri != null) {
                            try (java.io.OutputStream os = resolver.openOutputStream(itemUri)) {
                                if (os != null) {
                                    os.write(bytes);
                                    os.flush();
                                }
                            }
                            values.clear();
                            values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
                            resolver.update(itemUri, values, null, null);
                        }
                    } else {
                        java.io.File dlDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                        if (!dlDir.exists()) dlDir.mkdirs();
                        java.io.File outFile = new java.io.File(dlDir, cleanName);
                        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(outFile)) {
                            fos.write(bytes);
                            fos.flush();
                        }
                    }

                    final String savedName = cleanName;
                    if (activity != null) {
                        activity.runOnUiThread(() -> {
                            try {
                                android.widget.Toast.makeText(context, "İndirilenler klasörüne kaydedildi: " + savedName, android.widget.Toast.LENGTH_LONG).show();
                            } catch (Exception ignored) {}
                        });
                    }
                } catch (final Exception e) {
                    if (activity != null) {
                        activity.runOnUiThread(() -> {
                            try {
                                android.widget.Toast.makeText(context, "Dosya kaydedilemedi: " + e.getMessage(), android.widget.Toast.LENGTH_LONG).show();
                            } catch (Exception ignored) {}
                        });
                    }
                }
            }).start();
            return true;
        }

        @JavascriptInterface
        public boolean wakeOnLan(final String macAddress) {
            return powerOnDevice(macAddress, "255.255.255.255", "", 9);
        }

        @JavascriptInterface
        public boolean powerOnDevice(final String macAddress, final String subnetBroadcast, final String targetHost, final int customPort) {
            if (macAddress == null || macAddress.trim().isEmpty()) return false;
            final List<byte[]> macByteList = new ArrayList<>();
            for (String rawPart : macAddress.split("[,;\\s]+")) {
                String cleanMac = rawPart.replaceAll("[^0-9A-Fa-f]", "");
                if (cleanMac.length() == 12) {
                    try {
                        byte[] mb = new byte[6];
                        for (int i = 0; i < 6; i++) {
                            int index = i * 2;
                            mb[i] = (byte) Integer.parseInt(cleanMac.substring(index, index + 2), 16);
                        }
                        macByteList.add(mb);
                    } catch (Exception ignored) {}
                }
            }
            if (macByteList.isEmpty()) return false;

            new Thread(() -> {
                DatagramSocket socket = null;
                try {
                    List<byte[]> magicPackets = new ArrayList<>();
                    for (byte[] macBytes : macByteList) {
                        byte[] packetBytes = new byte[102];
                        for (int i = 0; i < 6; i++) {
                            packetBytes[i] = (byte) 0xFF;
                        }
                        for (int i = 1; i <= 16; i++) {
                            System.arraycopy(macBytes, 0, packetBytes, i * 6, 6);
                        }
                        magicPackets.add(packetBytes);
                    }

                    socket = new DatagramSocket();
                    socket.setBroadcast(true);

                    List<InetAddress> targets = getLocalBroadcastAddresses();
                    if (subnetBroadcast != null && !subnetBroadcast.isEmpty() && !subnetBroadcast.equals("-")) {
                        for (String sbPart : subnetBroadcast.split("[,;\\s]+")) {
                            String s = sbPart.trim();
                            if (s.isEmpty() || s.equals("-")) continue;
                            try {
                                InetAddress sb = InetAddress.getByName(s);
                                if (!targets.contains(sb)) targets.add(sb);
                            } catch (Exception ignored) {}
                        }
                    }
                    if (targetHost != null && !targetHost.isEmpty() && !targetHost.equals("-")) {
                        for (String thPart : targetHost.split("[,;\\s]+")) {
                            String h = thPart.trim();
                            if (h.isEmpty() || h.equals("-")) continue;
                            try {
                                InetAddress th = InetAddress.getByName(h);
                                if (!targets.contains(th)) targets.add(th);
                                int lastDot = h.lastIndexOf('.');
                                if (lastDot > 0) {
                                    InetAddress derivedBcast = InetAddress.getByName(h.substring(0, lastDot + 1) + "255");
                                    if (!targets.contains(derivedBcast)) targets.add(derivedBcast);
                                }
                            } catch (Exception ignored) {}
                        }
                    }

                    int[] ports = new int[]{9, 7, 4851, customPort > 0 ? customPort : 9};
                    for (int burst = 0; burst < 4; burst++) {
                        for (byte[] packetBytes : magicPackets) {
                            for (InetAddress addr : targets) {
                                for (int p : ports) {
                                    try {
                                        DatagramPacket pkt = new DatagramPacket(packetBytes, packetBytes.length, addr, p);
                                        socket.send(pkt);
                                    } catch (Exception ignored) {}
                                }
                            }
                        }
                        Thread.sleep(65);
                    }
                } catch (Exception ignored) {
                } finally {
                    if (socket != null) socket.close();
                }
            }).start();

            return true;
        }
    }
}
