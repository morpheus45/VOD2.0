package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.graphics.SurfaceTexture;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import org.json.JSONArray;

import androidx.annotation.OptIn;
import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * PIPSILY — Activité Android TV / Google TV  v5
 *
 * Corrections v5 :
 *  - MIXED_CONTENT_ALWAYS_ALLOW  → flux HTTP lisibles depuis page HTTPS
 *  - openInVlc() ajouté
 *  - clearCache() / getApkVersion() / downloadAndInstall() ajoutés
 *  - PIPSILY_NATIVE injecté (+ compat PIPSIFLIX_NATIVE)
 */
@OptIn(markerClass = UnstableApi.class)
public class TvActivity extends FragmentActivity implements TextureView.SurfaceTextureListener {

    private static final String TAG         = "PipsilyTV";
    private static final String APP_URL     = "https://morpheus45.github.io/VOD/";
    // Version réelle de l'APK (suivie sur versionCode du build.gradle)
    private static final String APK_VERSION = String.valueOf(BuildConfig.VERSION_CODE);

    // Référence faible vers l'instance active (pour reportProgress depuis PlayerActivity)
    static WeakReference<TvActivity> sInstance;

    WebView webView;

    // ── Aperçu vidéo "in-tile" (preview live ExoPlayer superposé au WebView) ──
    // TextureView et non SurfaceView : la SurfaceView (v30) rendait la vidéo
    // derrière la fenêtre (hole-punch) sur certaines TV → son sans image.
    private static OkHttpClient previewOkClient;
    private FrameLayout rootLayout;
    private TextureView previewTexture;
    private ExoPlayer   previewPlayer;
    private Surface     previewSurface;
    private String      previewPendingUrl = null;
    private String      previewCurrentUrl = null;

    // ── Téléchargement APK ──────────────────────────────────────────────
    private long             apkDownloadId = -1;
    private BroadcastReceiver apkReceiver  = null;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        setContentView(R.layout.activity_tv);
        webView    = findViewById(R.id.tvWebView);
        rootLayout = findViewById(R.id.rootLayout);
        sInstance = new WeakReference<>(this);

        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            // Vider le cache WebView au premier lancement de cette version
            android.content.SharedPreferences prefs =
                getSharedPreferences("pipsily_prefs", MODE_PRIVATE);
            String lastVer = prefs.getString("apk_version", "");
            if (!APK_VERSION.equals(lastVer)) {
                webView.clearCache(true);
                webView.clearHistory();
                prefs.edit().putString("apk_version", APK_VERSION).apply();
            }
            webView.loadUrl(APP_URL);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── CRITIQUE : autoriser les flux HTTP depuis une page HTTPS ──
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // User-Agent TV — contient "AndroidTV" pour que isTV=true dans le JS
        String ua = ws.getUserAgentString().replace("Mobile", "TV");
        ws.setUserAgentString(ua + " AndroidTV PIPSILY/5.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new TvBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (isVideoUrl(url)) { openVideoIntent(url); return true; }
                if (url.startsWith("https://morpheus45.github.io")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Injecter les flags natifs TV + focus D-pad sur premier élément
                view.evaluateJavascript(
                    "window.PIPSILY_NATIVE='android_tv';" +
                    "window.PIPSIFLIX_NATIVE='android_tv';" +   // compat legacy
                    "document.querySelector('.nav-btn')?.focus();", null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            private View customView;

            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                customView = view;
                webView.setVisibility(View.GONE);
                setContentView(view);
            }

            @Override
            public void onHideCustomView() {
                setContentView(R.layout.activity_tv);
                webView = findViewById(R.id.tvWebView);
                webView.setVisibility(View.VISIBLE);
            }
        });
    }

    void openVideoIntent(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(getPackageManager()) == null) {
                fallbackToWebPlayer(); return;
            }
            Intent chooser = Intent.createChooser(i, "Lire avec…");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            fallbackToWebPlayer();
        }
    }

    private void fallbackToWebPlayer() {
        runOnUiThread(() -> {
            try {
                if (webView != null) webView.loadUrl(APP_URL + "player.html");
            } catch (Exception ignored) {}
        });
    }

    private boolean isVideoUrl(String url) {
        if (url == null) return false;
        String lo = url.toLowerCase();
        return lo.contains("goldenlink.live/") ||
               lo.endsWith(".mkv") || lo.endsWith(".mp4") ||
               lo.endsWith(".avi") || lo.endsWith(".m3u8") || lo.endsWith(".ts") ||
               lo.contains("/movie/") || lo.contains("/series/") ||
               lo.contains("/live/");
    }

    // ── Téléchargement APK via DownloadManager ──────────────────────────
    /** Télécharge l'APK en arrière-plan puis lance l'installeur système. */
    void startApkDownload(String apkUrl) {
        runOnUiThread(() -> {
            try {
                // Destination : stockage externe app-privé (pas besoin de permission Android 10+)
                File dir  = getExternalFilesDir(null);
                if (dir == null) dir = getCacheDir();   // fallback interne
                final File dest = new File(dir, "PIPSILY_update.apk");
                if (dest.exists()) dest.delete();

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
                req.setTitle("PIPSILY — Mise à jour");
                req.setDescription("Téléchargement en cours…");
                req.setDestinationUri(Uri.fromFile(dest));
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                req.setMimeType("application/vnd.android.package-archive");

                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                apkDownloadId = dm.enqueue(req);

                Toast.makeText(TvActivity.this, "📥 Téléchargement en cours…", Toast.LENGTH_SHORT).show();

                // Feedback visuel JS — griser le bouton
                if (webView != null) {
                    webView.evaluateJavascript(
                        "var b=document.getElementById('apkDownloadBtn');" +
                        "if(b){b.textContent='📥 Téléchargement…';b.disabled=true;}", null);
                }

                // Receiver : lancer l'installation dès que le DL est terminé
                apkReceiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context ctx, Intent intent) {
                        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (id != apkDownloadId) return;
                        unregisterApkReceiver();
                        // Vérifier que le téléchargement a réellement réussi
                        boolean ok = false;
                        try {
                            android.database.Cursor c = dm.query(
                                new DownloadManager.Query().setFilterById(id));
                            if (c != null) {
                                if (c.moveToFirst()) {
                                    int st = c.getInt(c.getColumnIndexOrThrow(
                                        DownloadManager.COLUMN_STATUS));
                                    ok = (st == DownloadManager.STATUS_SUCCESSFUL);
                                }
                                c.close();
                            }
                        } catch (Exception ignored) {}
                        if (ok) {
                            installDownloadedApk(dest);
                        } else {
                            Toast.makeText(TvActivity.this,
                                "❌ Échec du téléchargement — réessayez", Toast.LENGTH_LONG).show();
                        }
                    }
                };
                IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 26) {
                    registerReceiver(apkReceiver, filter, 2 /* RECEIVER_EXPORTED */);
                } else {
                    registerReceiver(apkReceiver, filter);
                }
            } catch (Exception e) {
                Log.e(TAG, "startApkDownload", e);
                Toast.makeText(TvActivity.this,
                    "Erreur téléchargement : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void installDownloadedApk(File apkFile) {
        runOnUiThread(() -> {
            try {
                if (!apkFile.exists()) {
                    Toast.makeText(this, "Fichier APK introuvable", Toast.LENGTH_LONG).show();
                    return;
                }
                // Android 8+ : vérifier la permission "Installer des applis inconnues"
                // (sinon l'installeur échoue silencieusement — cause classique sur TV)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!getPackageManager().canRequestPackageInstalls()) {
                        Uri settingsUri = Uri.parse("package:" + getPackageName());
                        Intent allow = new Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, settingsUri);
                        allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(allow);
                        Toast.makeText(this,
                            "Activez \"Installer des applis inconnues\" puis relancez la mise à jour.",
                            Toast.LENGTH_LONG).show();
                        return;
                    }
                }
                Uri uri = FileProvider.getUriForFile(this, "com.pipsiflix.app.provider", apkFile);
                Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(install);
            } catch (Exception e) {
                Log.e(TAG, "installDownloadedApk", e);
                Toast.makeText(this,
                    "Erreur installation : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void unregisterApkReceiver() {
        if (apkReceiver != null) {
            try { unregisterReceiver(apkReceiver); } catch (Exception ignored) {}
            apkReceiver = null;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopLivePreview();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        unregisterApkReceiver();
        sInstance = null;
        if (previewPlayer != null) { previewPlayer.release(); previewPlayer = null; }
        if (previewSurface != null) { previewSurface.release(); previewSurface = null; }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Aperçu vidéo "in-tile" — TextureView ExoPlayer superposé au WebView
    //  (la TextureView se compose DANS la fenêtre : toujours visible au-dessus
    //  du WebView, contrairement à SurfaceView qui passait derrière — v30)
    // ══════════════════════════════════════════════════════════════════════

    private OkHttpDataSource.Factory buildPreviewDsFactory() {
        if (previewOkClient == null) {
            previewOkClient = new OkHttpClient.Builder()
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(15, TimeUnit.SECONDS)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .build();
        }
        return new OkHttpDataSource.Factory(previewOkClient)
                .setUserAgent("okhttp/4.11.0")
                .setDefaultRequestProperties(
                    java.util.Collections.singletonMap("Accept", "*/*")
                );
    }

    private void ensurePreviewPlayer() {
        if (previewPlayer != null) return;
        // Plafonner la qualité à SD : la vignette est petite, un flux léger
        // suffit et évite les saccades (décodage FHD inutile sur TV modeste)
        DefaultTrackSelector ts = new DefaultTrackSelector(this);
        ts.setParameters(ts.buildUponParameters().setMaxVideoSizeSd());
        // Buffer élargi : absorbe le jitter réseau des flux IPTV live
        DefaultLoadControl lc = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(20000, 60000, 1500, 5000)
                .build();
        previewPlayer = new ExoPlayer.Builder(this)
                .setTrackSelector(ts)
                .setLoadControl(lc)
                .build();
        previewPlayer.addListener(new Player.Listener() {
            @Override
            public void onRenderedFirstFrame() {
                // La vidéo est prête : révéler la surface (le poster reste visible jusque-là)
                if (previewTexture != null) previewTexture.setAlpha(1f);
            }
            @Override
            public void onPlayerError(PlaybackException error) {
                // Flux KO : masquer l'aperçu et prévenir le JS, qui essaiera
                // la qualité suivante du groupe (les flux SD IPTV sont souvent morts)
                Log.w(TAG, "Preview error: " + error.errorCode);
                stopLivePreview();
                if (webView != null) {
                    webView.evaluateJavascript(
                        "if(typeof window.onLivePreviewError==='function')window.onLivePreviewError();",
                        null);
                }
            }
        });
        if (previewSurface != null) previewPlayer.setVideoSurface(previewSurface);
    }

    private void ensurePreviewTexture() {
        if (previewTexture != null) return;
        previewTexture = new TextureView(this);
        previewTexture.setSurfaceTextureListener(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
        lp.gravity = Gravity.NO_GRAVITY;
        previewTexture.setLayoutParams(lp);
        previewTexture.setElevation(500f);
        // Invisible (alpha 0) tant que la 1ère frame n'est pas rendue — évite la vignette noire
        previewTexture.setAlpha(0f);
        previewTexture.setVisibility(View.GONE);
        rootLayout.addView(previewTexture);
    }

    private void playPreviewUrl(String url) {
        ensurePreviewPlayer();
        MediaSource source = new HlsMediaSource.Factory(buildPreviewDsFactory())
                .createMediaSource(MediaItem.fromUri(url));
        previewPlayer.stop();
        previewPlayer.clearMediaItems();
        previewPlayer.setMediaSource(source);
        previewPlayer.setPlayWhenReady(true);
        previewPlayer.prepare();
    }

    /** Appelé depuis app.js — démarre l'aperçu live dans la vignette focalisée. x,y,w,h en pixels physiques. */
    public void startLivePreview(String url, int x, int y, int w, int h) {
        if (url == null || url.isEmpty() || w <= 0 || h <= 0) return;
        ensurePreviewPlayer();
        ensurePreviewTexture();

        String finalUrl = url.startsWith("https://") ? url.replaceFirst("^https://", "http://") : url;

        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) previewTexture.getLayoutParams();
        lp.width      = w;
        lp.height     = h;
        lp.leftMargin = x;
        lp.topMargin  = y;
        lp.gravity    = Gravity.NO_GRAVITY;
        previewTexture.setLayoutParams(lp);
        previewTexture.setVisibility(View.VISIBLE);
        previewTexture.bringToFront();

        // Même URL déjà en cours → simple repositionnement, ne pas redémarrer le flux
        if (finalUrl.equals(previewCurrentUrl)) return;
        previewCurrentUrl = finalUrl;
        previewTexture.setAlpha(0f); // masqué jusqu'à la 1ère frame du nouveau flux

        if (previewSurface != null) {
            previewPendingUrl = null;
            playPreviewUrl(finalUrl);
        } else {
            previewPendingUrl = finalUrl;
        }
    }

    /** Appelé depuis app.js — arrête l'aperçu live et masque la surface. */
    public void stopLivePreview() {
        previewPendingUrl = null;
        previewCurrentUrl = null;
        if (previewPlayer != null) {
            previewPlayer.stop();
            previewPlayer.clearMediaItems();
        }
        if (previewTexture != null) {
            previewTexture.setAlpha(0f);
            previewTexture.setVisibility(View.GONE);
        }
    }

    // ── TextureView.SurfaceTextureListener ──────────────────────────────────
    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
        previewSurface = new Surface(surface);
        if (previewPlayer != null) previewPlayer.setVideoSurface(previewSurface);
        if (previewPendingUrl != null) {
            String url = previewPendingUrl;
            previewPendingUrl = null;
            playPreviewUrl(url);
        }
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {}

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
        if (previewPlayer != null) previewPlayer.clearVideoSurface();
        if (previewSurface != null) {
            previewSurface.release();
            previewSurface = null;
        }
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture surface) {}

    /**
     * Appelé par PlayerActivity.onDestroy() pour remonter la progression au WebView TV.
     * Injecte window.onAndroidPlayerClosed(url, posMs, durMs) dans le JavaScript.
     */
    static void reportProgress(final String url, final long posMs, final long durMs) {
        if (sInstance == null) return;
        TvActivity tv = sInstance.get();
        if (tv == null || tv.webView == null) return;
        final String safeUrl = url.replace("\\", "\\\\").replace("'", "\\'");
        tv.runOnUiThread(() -> {
            if (tv.webView != null) {
                String js = "if(typeof window.onAndroidPlayerClosed==='function')" +
                            "window.onAndroidPlayerClosed('" + safeUrl + "'," + posMs + "," + durMs + ");";
                tv.webView.evaluateJavascript(js, null);
                Log.d(TAG, "Progress reported: " + Math.round(posMs * 100.0 / durMs) + "% url=" + url);
            }
        });
    }

    // ── Télécommande ─────────────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                webView.evaluateJavascript(
                    "var v=document.querySelector('video');if(v)v.paused?v.play():v.pause();", null);
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                webView.evaluateJavascript("if(typeof goNext==='function')goNext();", null);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                webView.evaluateJavascript("if(typeof goPrev==='function')goPrev();", null);
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
                return false;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        webView.saveState(out);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Bridge TV
    // ══════════════════════════════════════════════════════════════════════
    class TvBridge {

        /** Lecteur natif ExoPlayer — appelé par app.js PipPlayer */
        @JavascriptInterface
        public void openPlayer(String url, String title, String subtitle,
                               String episodesJson, int epIndex) {
            openPlayerAt(url, title, subtitle, episodesJson, epIndex, 0L);
        }

        /** Lecteur natif avec reprise à une position donnée (en ms) */
        @JavascriptInterface
        public void openPlayerAt(String url, String title, String subtitle,
                                 String episodesJson, int epIndex, long startPositionMs) {
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",             url);
                i.putExtra("title",           title);
                i.putExtra("subtitle",        subtitle);
                i.putExtra("episodes",        episodesJson);
                i.putExtra("epIndex",         epIndex);
                i.putExtra("startPositionMs", startPositionMs);
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void openInVlc(String url, String title, boolean isLive) {
            // Redirigé vers ExoPlayer natif (plus fiable que VLC externe)
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void openVideo(String url, String title) {
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        /** Téléchargement direct + installation sans navigateur */
        @JavascriptInterface
        public void downloadAndInstall(String apkUrl) {
            startApkDownload(apkUrl);
        }

        @JavascriptInterface
        public void openDownloadUrl(String url) { startApkDownload(url); }

        @JavascriptInterface
        public void clearCache() {
            runOnUiThread(() -> {
                webView.clearCache(true);
                webView.clearHistory();
                webView.loadUrl(APP_URL);
            });
        }

        @JavascriptInterface
        public String getApkVersion() { return APK_VERSION; }

        @JavascriptInterface
        public String getDeviceType() { return "android_tv"; }

        /** Démarre l'aperçu vidéo dans la vignette focalisée (x,y,w,h en pixels physiques). */
        @JavascriptInterface
        public void startLivePreview(String url, int x, int y, int w, int h) {
            runOnUiThread(() -> TvActivity.this.startLivePreview(url, x, y, w, h));
        }

        /** Arrête l'aperçu vidéo dans la vignette. */
        @JavascriptInterface
        public void stopLivePreview() {
            runOnUiThread(TvActivity.this::stopLivePreview);
        }

        /**
         * Requête HTTP depuis Java (pas de CORS) — pour récupérer le synopsis Xtream.
         * Répond en appelant window[callbackFn](base64, ok) sur le thread UI.
         */
        @JavascriptInterface
        public void fetchUrlAsync(final String url, final String callbackFn) {
            new Thread(() -> {
                String b64 = null;
                try {
                    java.net.HttpURLConnection conn =
                        (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(8000);
                    conn.setRequestProperty("User-Agent", "okhttp/4.11.0");
                    conn.setRequestProperty("Accept", "application/json");
                    conn.setInstanceFollowRedirects(true);
                    if(conn.getResponseCode() >= 200 && conn.getResponseCode() < 300){
                        java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                        java.io.InputStream is = conn.getInputStream();
                        byte[] buf = new byte[4096]; int n;
                        while((n = is.read(buf)) != -1) baos.write(buf, 0, n);
                        is.close();
                        b64 = android.util.Base64.encodeToString(
                            baos.toByteArray(), android.util.Base64.NO_WRAP);
                    }
                    conn.disconnect();
                } catch(Exception ignored){}
                final String result = b64;
                runOnUiThread(() -> {
                    if(webView == null) return;
                    String js = result != null
                        ? "if(window['" + callbackFn + "'])window['" + callbackFn + "']('" + result + "',true);"
                        : "if(window['" + callbackFn + "'])window['" + callbackFn + "'](null,false);";
                    webView.evaluateJavascript(js, null);
                });
            }).start();
        }
    }
}
