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
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import java.io.File;
import java.lang.ref.WeakReference;

/**
 * PIPSILY — Activité principale (phone & tablet)  v5
 *
 * Corrections v5 :
 *  - MIXED_CONTENT_ALWAYS_ALLOW  → flux HTTP lisibles depuis page HTTPS
 *  - openInVlc()  ajouté (requis par app.js pour lecture directe)
 *  - clearCache() / getApkVersion() / downloadAndInstall() ajoutés
 *  - PIPSILY_NATIVE injecté (corrige détection TV/native dans le JS)
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG         = "PipsilyMain";
    private static final String APP_URL     = "https://morpheus45.github.io/VOD/";
    private static final String APK_VERSION = String.valueOf(BuildConfig.VERSION_CODE);

    // Référence faible vers l'instance active (pour reportProgress depuis PlayerActivity)
    static WeakReference<MainActivity> sInstance;

    WebView     webView;
    ProgressBar progressBar;

    // ── Téléchargement APK ──────────────────────────────────────────────
    private long              apkDownloadId = -1;
    private BroadcastReceiver apkReceiver   = null;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Plein écran immersif
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        setContentView(R.layout.activity_main);
        webView     = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        sInstance   = new WeakReference<>(this);

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

    @SuppressLint({"SetJavaScriptEnabled", "SetJavaScriptInterface"})
    private void configureWebView() {
        WebSettings ws = webView.getSettings();

        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── CRITIQUE : autoriser les flux HTTP depuis une page HTTPS ──
        //    Sans cette ligne, les vidéos HTTP sont bloquées (mixed content)
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // User-Agent : PIPSILY/5
        ws.setUserAgentString(ws.getUserAgentString() + " PIPSILY/5.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // Bridge JavaScript ↔ Java
        webView.addJavascriptInterface(new PipsilyBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();

                // Intent vidéo intercepté (goldenlink ou extension vidéo connue)
                if (isVideoUrl(url)) {
                    openVideoIntent(url);
                    return true;
                }

                // Rester dans notre domaine
                if (url.startsWith("https://morpheus45.github.io")) return false;

                // Tout le reste → navigateur externe
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                // Injecter les flags natifs (PIPSILY_NATIVE pour le JS renommé)
                view.evaluateJavascript(
                    "window.PIPSILY_NATIVE='android';" +
                    "window.PIPSIFLIX_NATIVE='android';", null);  // compat legacy
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (progress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(progress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            private View customView;

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                customView = view;
                webView.setVisibility(View.GONE);
                setContentView(view);
            }

            @Override
            public void onHideCustomView() {
                setContentView(R.layout.activity_main);
                webView = findViewById(R.id.webView);
                webView.setVisibility(View.VISIBLE);
                customView = null;
            }
        });
    }

    /** Ouvre une URL vidéo dans un lecteur système (VLC, MX Player…)
     *  Si AUCUNE app vidéo n'est installée, fallback sur player.html (WebView). */
    void openVideoIntent(String url) {
        try {
            // Garder l'URL telle quelle — les serveurs HTTPS DOIVENT rester HTTPS
            // (sinon mixed-content sur la WebView). Pour HTTP cleartext, configuré
            // dans network_security_config.xml.
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(url), "video/*");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            // Vérifier qu'au moins une app peut gérer l'intent AVANT de démarrer
            if (intent.resolveActivity(getPackageManager()) == null) {
                fallbackToWebPlayer(url);
                return;
            }

            // Chooser : laisse l'utilisateur choisir VLC / MX Player / etc.
            Intent chooser = Intent.createChooser(intent, "Lire avec…");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            // Toute erreur → fallback player.html
            fallbackToWebPlayer(url);
        }
    }

    /** Fallback : ouvre player.html dans la WebView (lecture HTML5 / HLS.js) */
    private void fallbackToWebPlayer(String url) {
        runOnUiThread(() -> {
            try {
                if (webView != null) {
                    // player.html lit l'URL depuis sessionStorage,
                    // déjà rempli par app.js avant l'appel à openInVlc.
                    webView.loadUrl(APP_URL + "player.html");
                }
            } catch (Exception ignored) {}
        });
    }

    private boolean isVideoUrl(String url) {
        if (url == null) return false;
        String lo = url.toLowerCase();
        return lo.contains("goldenlink.live/") ||
               lo.endsWith(".mkv") || lo.endsWith(".mp4") ||
               lo.endsWith(".avi") || lo.endsWith(".mov") ||
               lo.endsWith(".m3u8") || lo.endsWith(".ts") ||
               lo.contains("/movie/") || lo.contains("/series/") ||
               lo.contains("/live/");
    }

    // ── Téléchargement APK via DownloadManager ──────────────────────────
    void startApkDownload(String apkUrl) {
        runOnUiThread(() -> {
            try {
                File dir  = getExternalFilesDir(null);
                if (dir == null) dir = getCacheDir();
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

                Toast.makeText(MainActivity.this, "📥 Téléchargement en cours…", Toast.LENGTH_SHORT).show();

                if (webView != null) {
                    webView.evaluateJavascript(
                        "var b=document.getElementById('apkDownloadBtn');" +
                        "if(b){b.textContent='📥 Téléchargement…';b.disabled=true;}", null);
                }

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
                            Toast.makeText(MainActivity.this,
                                "❌ Échec du téléchargement — réessayez", Toast.LENGTH_LONG).show();
                        }
                    }
                };
                IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                // RECEIVER_EXPORTED (3-arg) n'existe qu'à partir d'API 33 (Android 13)
                // Sur API 21-32, on utilise la version 2-arg (broadcast système = OK sans flag)
                if (Build.VERSION.SDK_INT >= 33) {
                    registerReceiver(apkReceiver, filter, Context.RECEIVER_EXPORTED);
                } else {
                    registerReceiver(apkReceiver, filter);
                }
            } catch (Throwable e) {  // Throwable attrape aussi Error (ex: NoSuchMethodError)
                Log.e(TAG, "startApkDownload", e);
                Toast.makeText(MainActivity.this,
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
                // Android 8+ : vérifier la permission d'installation depuis cette source
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!getPackageManager().canRequestPackageInstalls()) {
                        // Ouvrir directement les paramètres pour cette appli
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
                // INSTALL_REPLACE_EXISTING : pas de dialogue "Voulez-vous remplacer ?"
                install.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
                install.putExtra("android.intent.extra.RETURN_RESULT", false);
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
    protected void onDestroy() {
        super.onDestroy();
        unregisterApkReceiver();
        sInstance = null;
    }

    /**
     * Appelé par PlayerActivity.onDestroy() pour remonter la progression au WebView.
     * Injecte window.onAndroidPlayerClosed(url, posMs, durMs) dans le JavaScript.
     */
    static void reportProgress(final String url, final long posMs, final long durMs) {
        if (sInstance == null) return;
        MainActivity main = sInstance.get();
        if (main == null || main.webView == null) return;
        // Échapper l'URL pour l'injection JS (remplacer ' par \')
        final String safeUrl = url.replace("\\", "\\\\").replace("'", "\\'");
        main.runOnUiThread(() -> {
            if (main.webView != null) {
                String js = "if(typeof window.onAndroidPlayerClosed==='function')" +
                            "window.onAndroidPlayerClosed('" + safeUrl + "'," + posMs + "," + durMs + ");";
                main.webView.evaluateJavascript(js, null);
                Log.d("PipsilyMain", "Progress reported: " + Math.round(posMs * 100.0 / durMs) + "% url=" + url);
            }
        });
    }

    // ── Touche Retour ──
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
            keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
            keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            webView.evaluateJavascript(
                "var v=document.querySelector('video');if(v)v.paused?v.play():v.pause();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            webView.evaluateJavascript("if(typeof goNext==='function')goNext();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
            webView.evaluateJavascript("if(typeof goPrev==='function')goPrev();", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Bridge JavaScript ↔ Java  (window.AndroidBridge)
    // ══════════════════════════════════════════════════════════════════════
    class PipsilyBridge {

        /** Lecteur natif ExoPlayer — appelé par app.js PipPlayer */
        @JavascriptInterface
        public void openPlayer(String url, String title, String subtitle,
                               String episodesJson, int epIndex) {
            openPlayerAt(url, title, subtitle, episodesJson, epIndex, 0L);
        }

        /** Lecteur natif ExoPlayer avec reprise à la position sauvegardée */
        @JavascriptInterface
        public void openPlayerAt(String url, String title, String subtitle,
                                 String episodesJson, int epIndex, long startPositionMs) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",             url);
                i.putExtra("title",           title);
                i.putExtra("subtitle",        subtitle);
                i.putExtra("episodes",        episodesJson);
                i.putExtra("epIndex",         epIndex);
                i.putExtra("startPositionMs", startPositionMs);
                startActivity(i);
            });
        }

        /** Lecture directe (redirigé vers ExoPlayer) */
        @JavascriptInterface
        public void openInVlc(String url, String title, boolean isLive) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        /** Lecture (appelé par player.js) */
        @JavascriptInterface
        public void openVideo(String url, String title) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        /** Télécharge et installe l'APK directement (sans navigateur) */
        @JavascriptInterface
        public void downloadAndInstall(String apkUrl) {
            startApkDownload(apkUrl);
        }

        /** Fallback (compatibilité APK anciens) */
        @JavascriptInterface
        public void openDownloadUrl(String url) {
            startApkDownload(url);
        }

        /** Vide le cache WebView et recharge */
        @JavascriptInterface
        public void clearCache() {
            runOnUiThread(() -> {
                webView.clearCache(true);
                webView.clearHistory();
                webView.loadUrl(APP_URL);
            });
        }

        /** Retourne la version de l'APK (pour la vérification de mise à jour) */
        @JavascriptInterface
        public String getApkVersion() {
            return APK_VERSION;
        }

        /** Type d'appareil */
        @JavascriptInterface
        public String getDeviceType() {
            return "android_phone";
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
