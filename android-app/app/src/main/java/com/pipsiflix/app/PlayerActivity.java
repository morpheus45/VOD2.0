package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.fragment.app.FragmentActivity;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.PlayerView;

import okhttp3.OkHttpClient;

import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * PIPSILY — Lecteur vidéo natif ExoPlayer v1
 *
 * Supporte :
 *  - Flux HLS (.m3u8) : TV en direct, séries
 *  - Fichiers directs (.mp4, .mkv, etc.) : VOD
 *  - Navigation épisodes (prev/next via boutons + télécommande)
 *  - Télécommande TV (KEYCODE_MEDIA_*)
 *  - HTTP et HTTPS (pas de restriction mixed content côté Java)
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends FragmentActivity {

    private static final String TAG = "PipsilyPlayer";

    // User-Agent universellement accepté par les serveurs IPTV / Xtream Codes
    private static final String IPTV_UA = "okhttp/4.11.0";

    // Client OkHttp partagé (connexion pooling, meilleure gestion des redirects CDN)
    private static OkHttpClient okClient;

    private ExoPlayer    player;
    private PlayerView   playerView;
    private TextView     titleView, subtitleView;
    private Button       btnPrev, btnNext;
    private LinearLayout epNavBar;
    private LinearLayout titleBar;          // overlay titre haut

    private String[] epUrls;
    private String[] epLabels;
    private String   seriesTitle     = "";
    private int      currentIdx      = 0;
    private boolean  hlsRetried      = false;
    private boolean  controllerShown = false; // état controller pour toggle TV
    private String   currentUrl      = "";    // URL en cours (pour rapport de progression)
    private long     startPositionMs = 0L;   // position de reprise (0 = depuis le début)

    // ─── Lifecycle ────────────────────────────────────────────────────
    @SuppressLint("SourceLockedOrientationActivity")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Garder l'écran allumé + plein écran immersif
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setImmersive();
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

        setContentView(R.layout.activity_player);

        playerView   = findViewById(R.id.playerView);
        titleBar     = findViewById(R.id.titleBar);
        titleView    = findViewById(R.id.playerTitle);
        subtitleView = findViewById(R.id.playerSubtitle);
        epNavBar     = findViewById(R.id.epNavBar);
        btnPrev      = findViewById(R.id.btnPrev);
        btnNext      = findViewById(R.id.btnNext);

        // ── Synchroniser titleBar + epNavBar avec la visibilité du controller ──
        // Le titleBar est une overlay indépendante → il faut la lier manuellement
        playerView.setControllerVisibilityListener(
            (PlayerView.ControllerVisibilityListener) visibility -> {
                controllerShown = (visibility == View.VISIBLE);
                if (titleBar != null) titleBar.setVisibility(visibility);
                // epNavBar : ne montrer que si multi-épisodes
                if (epNavBar != null && epUrls != null && epUrls.length > 1) {
                    epNavBar.setVisibility(visibility);
                }
            }
        );

        // Ne pas auto-afficher le controller au démarrage de la lecture
        // (sinon il reste bloqué visible sur TV)
        playerView.setControllerAutoShow(false);

        // Focus sur playerView lui-même (pas ses boutons internes)
        // → libère le D-pad focus qui empêche le timer d'auto-hide
        playerView.setFocusable(true);
        playerView.requestFocus();

        // ── Lire les extras de l'Intent ──
        String url      = getIntent().getStringExtra("url");      // URL principale
        String title    = getIntent().getStringExtra("title");    // Titre film/série
        String subtitle = getIntent().getStringExtra("subtitle"); // Sous-titre / catégorie
        String epsJson  = getIntent().getStringExtra("episodes"); // JSON épisodes (optionnel)
        int    epIdx    = getIntent().getIntExtra("epIndex", -1);
        startPositionMs = getIntent().getLongExtra("startPositionMs", 0L);

        seriesTitle = title != null ? title : "";
        titleView.setText(seriesTitle);

        if (subtitle != null && !subtitle.isEmpty()) {
            subtitleView.setText(subtitle);
            subtitleView.setVisibility(View.VISIBLE);
        }

        // ── Parser la liste d'épisodes ──
        List<String> urlList   = new ArrayList<>();
        List<String> labelList = new ArrayList<>();

        if (epsJson != null && !epsJson.isEmpty() && !epsJson.equals("[]")) {
            try {
                JSONArray arr = new JSONArray(epsJson);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject ep    = arr.getJSONObject(i);
                    String     epUrl = ep.optString("url", "");
                    if (epUrl.isEmpty()) continue;
                    String lbl = ep.optString("episode_label", "");
                    String ttl = ep.optString("title", "");
                    String display = lbl.isEmpty() ? ttl : (ttl.isEmpty() ? lbl : lbl + " — " + ttl);
                    urlList.add(epUrl);
                    labelList.add(display);
                }
            } catch (Exception ignored) {}
        }

        if (urlList.isEmpty()) {
            // Lecture simple (pas d'épisodes)
            urlList.add(url != null ? url : "");
            labelList.add(subtitle != null ? subtitle : "");
            currentIdx = 0;
        } else {
            currentIdx = (epIdx >= 0 && epIdx < urlList.size()) ? epIdx : 0;
        }

        epUrls   = urlList.toArray(new String[0]);
        epLabels = labelList.toArray(new String[0]);

        // ── Boutons épisodes ──
        if (epUrls.length > 1) {
            epNavBar.setVisibility(View.VISIBLE);
            updateEpButtons();
            btnPrev.setOnClickListener(v -> goEp(currentIdx - 1));
            btnNext.setOnClickListener(v -> goEp(currentIdx + 1));
        }

        // ── Lancer la lecture ──
        playUrl(epUrls[currentIdx], epLabels[currentIdx]);
    }

    // ─── Initialiser ExoPlayer et lancer la lecture ───────────────────
    private void playUrl(String url, String epLabel) {
        currentUrl = (url != null) ? url : "";
        // ── Garde URL vide ──
        if (url == null || url.trim().isEmpty()) {
            Log.e(TAG, "playUrl: URL vide !");
            Toast.makeText(this, "Erreur : URL de lecture manquante", Toast.LENGTH_LONG).show();
            return;
        }
        Log.d(TAG, "playUrl: " + url);

        // Afficher le bon sous-titre
        if (epUrls.length > 1 && epLabel != null && !epLabel.isEmpty()) {
            subtitleView.setText(epLabel);
            subtitleView.setVisibility(View.VISIBLE);
        }

        hlsRetried = false;

        if (player == null) {
            // Préférer la piste audio française PRINCIPALE (pas l'audiodescription).
            // ROLE_FLAG_MAIN écarte les pistes "describes video" quand elles sont
            // correctement étiquetées dans le conteneur.
            DefaultTrackSelector ts = new DefaultTrackSelector(this);
            ts.setParameters(ts.buildUponParameters()
                    .setPreferredAudioLanguage("fra")
                    .setPreferredAudioRoleFlags(C.ROLE_FLAG_MAIN));
            // Renderers + décodeur FFmpeg logiciel (E-AC3/AC3/DTS) en repli :
            // décodage matériel d'abord, FFmpeg quand la plateforme ne sait pas
            // (TV sans licence Dolby → la VF E-AC3 redevient lisible)
            androidx.media3.exoplayer.DefaultRenderersFactory rf =
                new androidx.media3.exoplayer.DefaultRenderersFactory(this)
                    .setExtensionRendererMode(
                        androidx.media3.exoplayer.DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
            player = new ExoPlayer.Builder(this, rf).setTrackSelector(ts).build();
            playerView.setPlayer(player);
            playerView.setKeepScreenOn(true);

            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (state == Player.STATE_ENDED && currentIdx < epUrls.length - 1) {
                        goEp(currentIdx + 1);
                    }
                }

                @Override
                public void onTracksChanged(Tracks tracks) {
                    // Détecter le repli silencieux : la piste audio PAR DÉFAUT du fichier
                    // (VF principale) n'est pas celle jouée → souvent l'audiodescription
                    // (ex : VF E-AC3 5.1 non décodable par l'appareil → bascule AAC).
                    boolean defaultExists = false, defaultSelected = false, otherSelected = false;
                    int audioGroups = 0;
                    for (Tracks.Group g : tracks.getGroups()) {
                        if (g.getType() != C.TRACK_TYPE_AUDIO) continue;
                        audioGroups++;
                        for (int i = 0; i < g.length; i++) {
                            boolean isDefault =
                                (g.getTrackFormat(i).selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0;
                            if (isDefault) defaultExists = true;
                            if (g.isTrackSelected(i)) {
                                if (isDefault) defaultSelected = true; else otherSelected = true;
                            }
                        }
                    }
                    if (audioGroups > 1 && defaultExists && !defaultSelected && otherSelected) {
                        Toast.makeText(PlayerActivity.this,
                            "⚠️ Piste VF principale non supportée par cet appareil — " +
                            "piste secondaire utilisée (souvent audiodescription).\n" +
                            "Touche ⬆ : changer de piste audio.", Toast.LENGTH_LONG).show();
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    Log.e(TAG, "ExoPlayer error [" + error.errorCode + "]", error);

                    // ── Retry automatique : ProgressiveMedia → HLS ──
                    String curUrl = epUrls[currentIdx];
                    String lo     = curUrl.toLowerCase();
                    boolean wasProgressive = !lo.contains(".m3u8")
                            && !lo.contains("/live/")
                            && !lo.contains("get_series_info");

                    if (wasProgressive && !hlsRetried) {
                        hlsRetried = true;
                        Log.i(TAG, "Retry HLS: " + curUrl);
                        runOnUiThread(() -> {
                            player.stop();
                            player.clearMediaItems();
                            MediaSource src = new HlsMediaSource.Factory(buildDsFactory())
                                    .createMediaSource(MediaItem.fromUri(curUrl));
                            player.setMediaSource(src);
                            player.setPlayWhenReady(true);
                            player.prepare();
                        });
                        return;
                    }

                    // ── Lire le code HTTP exact depuis la cause ──
                    String label = buildErrorLabel(error);
                    runOnUiThread(() ->
                        Toast.makeText(PlayerActivity.this, label, Toast.LENGTH_LONG).show()
                    );
                }
            });
        } else {
            player.stop();
            player.clearMediaItems();
        }

        String lUrl = url.toLowerCase();
        MediaSource source;

        if (lUrl.contains(".m3u8") || lUrl.contains("/live/") || lUrl.contains("get_series_info")) {
            // ── HLS : TV Live, séries, playlists Xtream ──
            source = new HlsMediaSource.Factory(buildDsFactory())
                    .createMediaSource(MediaItem.fromUri(url));
        } else {
            // ── Progressive : VOD mp4/mkv/ts Xtream ──
            source = new ProgressiveMediaSource.Factory(buildDsFactory())
                    .createMediaSource(MediaItem.fromUri(url));
        }

        player.setMediaSource(source);
        player.setPlayWhenReady(true);
        // Reprise à la position sauvegardée (0 = depuis le début)
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
            startPositionMs = 0L; // consommé — ne pas re-seeker lors d'un changement d'épisode
        }
        player.prepare();

        // Montrer le controller brièvement au démarrage (titre visible 3s)
        // puis l'auto-hide prend le relais (show_timeout=4000 dans le XML)
        playerView.showController();
        playerView.postDelayed(() -> {
            if (player != null && player.isPlaying()) {
                playerView.hideController();
            }
        }, 3000);
    }

    /**
     * Fabrique OkHttp partagée.
     *
     * Avantages vs DefaultHttpDataSource :
     *  - Suit les redirects HTTP→HTTPS et vers d'autres hôtes CDN (406 fix)
     *  - Envoie Accept: * / * par défaut (évite les 406 "Not Acceptable")
     *  - Connection pooling → démarrage plus rapide pour les épisodes suivants
     *  - Gestion SSL plus robuste
     */
    private OkHttpDataSource.Factory buildDsFactory() {
        if (okClient == null) {
            okClient = new OkHttpClient.Builder()
                    .connectTimeout(20, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .build();
        }
        return new OkHttpDataSource.Factory(okClient)
                .setUserAgent(IPTV_UA)
                // Accept: */* évite les 406 sur les CDN qui vérifient le content-type
                .setDefaultRequestProperties(
                    java.util.Collections.singletonMap("Accept", "*/*")
                );
    }

    /** Traduit PlaybackException en message lisible avec le code HTTP exact */
    private String buildErrorLabel(PlaybackException error) {
        // Chercher le code HTTP réel dans la chaîne des causes
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                int code = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
                switch (code) {
                    case 403: return "Accès refusé (403) — abonnement expiré ou flux restreint.";
                    case 404: return "Flux introuvable (404) — ce contenu n'est plus disponible.";
                    case 500:
                    case 502:
                    case 503: return "Erreur serveur (" + code + ") — réessayez dans quelques instants.";
                    default:  return "Erreur HTTP " + code + " — serveur inaccessible.";
                }
            }
            cause = cause.getCause();
        }
        // Erreurs non-HTTP
        switch (error.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
                return "Connexion impossible — vérifiez votre réseau.";
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "Délai dépassé — serveur trop lent.";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
                return "Codec non supporté par cet appareil.";
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
                return "Format vidéo non reconnu.";
            default:
                return "Erreur lecture [" + error.errorCode + "] — " + error.getMessage();
        }
    }

    // ─── Navigation épisodes ──────────────────────────────────────────
    private void goEp(int idx) {
        if (idx < 0 || idx >= epUrls.length) return;
        currentIdx = idx;
        updateEpButtons();
        playUrl(epUrls[currentIdx], epLabels[currentIdx]);
    }

    private void updateEpButtons() {
        btnPrev.setEnabled(currentIdx > 0);
        btnPrev.setAlpha(currentIdx > 0 ? 1f : 0.4f);
        btnNext.setEnabled(currentIdx < epUrls.length - 1);
        btnNext.setAlpha(currentIdx < epUrls.length - 1 ? 1f : 0.4f);
    }

    // ─── Bascule de piste audio (VF principale ↔ audiodescription, etc.) ──
    private void cycleAudioTrack() {
        if (player == null) return;
        List<Tracks.Group> audio = new ArrayList<>();
        for (Tracks.Group g : player.getCurrentTracks().getGroups())
            if (g.getType() == C.TRACK_TYPE_AUDIO) audio.add(g);
        if (audio.size() < 2) {
            Toast.makeText(this, "Une seule piste audio disponible", Toast.LENGTH_SHORT).show();
            return;
        }
        int cur = 0;
        for (int i = 0; i < audio.size(); i++) if (audio.get(i).isSelected()) cur = i;
        // Prochaine piste SUPPORTÉE par l'appareil
        for (int step = 1; step <= audio.size(); step++) {
            Tracks.Group g = audio.get((cur + step) % audio.size());
            if (!g.isSupported()) continue;
            TrackSelectionOverride ov = new TrackSelectionOverride(g.getMediaTrackGroup(), 0);
            player.setTrackSelectionParameters(player.getTrackSelectionParameters()
                    .buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                    .addOverride(ov)
                    .build());
            Format f = g.getTrackFormat(0);
            String codec = f.sampleMimeType != null
                ? f.sampleMimeType.replace("audio/", "").toUpperCase() : "?";
            String label = (f.label != null && !f.label.isEmpty() ? f.label
                          : (f.language != null ? f.language.toUpperCase() : "Piste"))
                + " · " + f.channelCount + " canaux · " + codec;
            Toast.makeText(this, "🔊 Piste audio : " + label, Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, "Aucune autre piste audio supportée par cet appareil",
                Toast.LENGTH_LONG).show();
    }

    // ─── Télécommande TV ─────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (player == null) return super.onKeyDown(keyCode, event);
        switch (keyCode) {

            // ⬆ (controller masqué) ou touche dédiée : changer de piste audio
            case KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK:
                cycleAudioTrack();
                return true;
            case KeyEvent.KEYCODE_DPAD_UP:
                if (!controllerShown) {
                    cycleAudioTrack();
                    return true;
                }
                return false;

            // OK / Sélection : afficher si masqué, masquer si visible
            case KeyEvent.KEYCODE_DPAD_CENTER:
                if (controllerShown) {
                    playerView.hideController();
                } else {
                    playerView.showController();
                }
                return true;

            // Lecture / Pause
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_SPACE:
                if (player.isPlaying()) player.pause(); else player.play();
                playerView.showController(); // montre la barre quand on pause/reprend
                return true;

            // Épisode suivant / précédent
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                goEp(currentIdx + 1);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                goEp(currentIdx - 1);
                return true;

            // Avance / recul 10s (←→ quand controller masqué)
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                player.seekTo(Math.min(player.getCurrentPosition() + 10_000, player.getDuration()));
                playerView.showController();
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                player.seekTo(Math.max(player.getCurrentPosition() - 10_000, 0));
                playerView.showController();
                return true;

            // ←→ : avance/recul SEULEMENT si controller masqué
            // (si controller visible, laisser le focus naviguer les boutons)
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (!controllerShown) {
                    player.seekTo(Math.min(player.getCurrentPosition() + 10_000, player.getDuration()));
                    return true;
                }
                return false;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (!controllerShown) {
                    player.seekTo(Math.max(player.getCurrentPosition() - 10_000, 0));
                    return true;
                }
                return false;

            case KeyEvent.KEYCODE_BACK:
                finish();
                return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────
    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        setImmersive();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // ── Remonter la progression au WebView avant de libérer le player ──
        if (player != null && !currentUrl.isEmpty()) {
            long posMs = player.getCurrentPosition();
            long durMs = player.getDuration();
            // Correction : pour les flux HLS (séries), getDuration() retourne
            // Long.MIN_VALUE (TIME_UNSET) si non encore connu → durMs > 0 échoue.
            // On rapporte dès 30s regardées ; on passe durMs=0 si inconnue
            // (le JS gère le cas durée=0 via un pct de secours).
            long safeDur = (durMs > 0 && durMs != Long.MIN_VALUE) ? durMs : 0;
            if (posMs > 30000) {
                if (MainActivity.sInstance != null && MainActivity.sInstance.get() != null) {
                    MainActivity.reportProgress(currentUrl, posMs, safeDur);
                } else {
                    TvActivity.reportProgress(currentUrl, posMs, safeDur);
                }
            }
            player.release();
            player = null;
        }
    }

    // ─── Plein écran immersif ─────────────────────────────────────────
    private void setImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY     |
                View.SYSTEM_UI_FLAG_FULLSCREEN           |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION      |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN    |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }
}
