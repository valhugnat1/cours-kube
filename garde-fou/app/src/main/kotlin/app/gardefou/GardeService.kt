package app.gardefou

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import app.gardefou.core.Decision
import app.gardefou.core.Moteur
import java.time.LocalDateTime
import java.time.ZoneId

const val INSTAGRAM = "com.instagram.android"
const val YOUTUBE = "com.google.android.youtube"

/**
 * Comment on reconnaît un écran de vidéos courtes : par l'identifiant d'une vue
 * qui n'existe que sur cet écran. Ces identifiants sont internes aux applis et
 * peuvent changer lors d'une mise à jour : si le blocage des Reels ne marche
 * plus, c'est ici qu'il faut regarder (voir le README, « Si les Reels ne sont
 * plus détectés »).
 */
val DETECTEURS_SHORTS: Map<String, List<String>> = mapOf(
    INSTAGRAM to listOf("clips_viewer_view_pager"),
    YOUTUBE to listOf("reel_recycler", "reel_watch_player"),
)

/**
 * Le cœur côté Android. Android prévient ce service à chaque changement d'écran
 * dans Instagram ou YouTube. Tant qu'Instagram est au premier plan, une boucle
 * tourne une fois par seconde : elle compte le temps et demande au Moteur si on
 * a encore le droit d'être là.
 */
class GardeService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var boucleActive = false
    private var dernierTick = 0L
    private var dernierScan = 0L
    private var dernierRetour = 0L

    private val boucle = object : Runnable {
        override fun run() {
            if (tick()) {
                handler.postDelayed(this, 1000)
            } else {
                boucleActive = false
                dernierTick = 0L
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val paquet = event?.packageName?.toString() ?: return
        if (paquet == INSTAGRAM && !boucleActive) {
            boucleActive = true
            handler.post(boucle)
        }
        verifierShorts(paquet)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        handler.removeCallbacks(boucle)
        super.onDestroy()
    }

    /** Renvoie false quand il faut arrêter la boucle (Instagram n'est plus à l'écran). */
    private fun tick(): Boolean {
        val ecranAllume = getSystemService(PowerManager::class.java).isInteractive
        val auPremierPlan = if (ecranAllume) rootInActiveWindow?.packageName?.toString() else null
        if (auPremierPlan != INSTAGRAM) return false

        val chrono = SystemClock.elapsedRealtime()
        val delta = if (dernierTick == 0L) 0L else (chrono - dernierTick).coerceIn(0L, 5000L)
        dernierTick = chrono

        val (etat, decision) = Moteur.evaluer(
            Depot.config, Depot.etat, System.currentTimeMillis(), ZoneId.systemDefault(), delta,
        )
        Depot.enregistrerEtat(etat)

        when (decision) {
            is Decision.Bloque -> {
                startActivity(
                    Intent(this, BlocageActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        .putExtra(BlocageActivity.RAISON, decision.raison.name)
                        .putExtra(BlocageActivity.JUSQUA, decision.jusqua ?: 0L)
                )
                return false
            }
            is Decision.Autorise -> {
                val reste = decision.resteMs
                if (reste != null && reste in 59_001L..60_000L) message("Plus qu'une minute sur Instagram")
            }
        }
        return true
    }

    /** Si un écran de Reels / Shorts est visible et que la règle l'interdit : retour arrière. */
    private fun verifierShorts(paquet: String) {
        val identifiants = DETECTEURS_SHORTS[paquet] ?: return
        if (paquet == YOUTUBE && !Depot.config.shortsYoutube) return
        val chrono = SystemClock.elapsedRealtime()
        if (chrono - dernierScan < 300 || chrono - dernierRetour < 1200) return
        dernierScan = chrono
        if (!Moteur.regleCourante(Depot.config, LocalDateTime.now()).bloquerShorts) return

        val racine = rootInActiveWindow ?: return
        if (racine.packageName?.toString() != paquet) return
        val shortsVisibles = identifiants.any { id ->
            racine.findAccessibilityNodeInfosByViewId("$paquet:id/$id").any { it.isVisibleToUser }
        }
        if (shortsVisibles) {
            dernierRetour = chrono
            performGlobalAction(GLOBAL_ACTION_BACK)
            message("Vidéos courtes bloquées en ce moment")
        }
    }

    private fun message(texte: String) = Toast.makeText(this, texte, Toast.LENGTH_SHORT).show()
}
