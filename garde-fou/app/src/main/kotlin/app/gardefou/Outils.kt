package app.gardefou

import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import app.gardefou.core.Mode
import app.gardefou.core.Phase
import app.gardefou.core.Regle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ThemeGardeFou(contenu: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme(),
        content = contenu,
    )
}

/** Le service d'accessibilité est-il activé dans les réglages du téléphone ? */
fun serviceActif(contexte: Context): Boolean {
    val actifs = Settings.Secure.getString(
        contexte.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    val moi = ComponentName(contexte, GardeService::class.java)
    return actifs.split(':').any { ComponentName.unflattenFromString(it) == moi }
}

private val formatHeure = DateTimeFormatter.ofPattern("HH:mm")

fun heure(epochMs: Long): String =
    Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()).format(formatHeure)

fun heureDuJour(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

fun duree(ms: Long): String {
    val secondes = (ms.coerceAtLeast(0) + 999) / 1000
    val h = secondes / 3600
    val m = (secondes % 3600) / 60
    val s = secondes % 60
    return when {
        h > 0 -> "$h h %02d".format(m)
        m > 0 -> "$m min %02d".format(s)
        else -> "$s s"
    }
}

val NOMS_JOURS = listOf("lun", "mar", "mer", "jeu", "ven", "sam", "dim")

fun texteJours(jours: Set<Int>): String = when {
    jours.size == 7 -> "tous les jours"
    jours == setOf(1, 2, 3, 4, 5) -> "lun → ven"
    jours == setOf(6, 7) -> "week-end"
    jours.isEmpty() -> "aucun jour"
    else -> jours.sorted().joinToString(" ") { NOMS_JOURS[it - 1] }
}

fun texteHoraire(p: Phase): String =
    if (p.debutMin == p.finMin) "toute la journée" else "${heureDuJour(p.debutMin)} → ${heureDuJour(p.finMin)}"

fun texteRegle(r: Regle): String {
    val base = when (r.mode) {
        Mode.LIBRE -> "Libre"
        Mode.BLOQUE -> "Bloqué"
        Mode.SESSIONS -> "Sessions de ${r.sessionMin} min, pause de ${r.pauseMin} min" +
            if (r.maxSessions > 0) ", ${r.maxSessions} par jour max" else ""
    }
    return if (r.bloquerShorts && r.mode != Mode.BLOQUE) "$base · Reels bloqués" else base
}
