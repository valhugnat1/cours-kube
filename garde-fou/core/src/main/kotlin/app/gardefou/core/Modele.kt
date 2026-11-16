package app.gardefou.core

import java.time.LocalDateTime

/** Ce qu'une règle fait d'Instagram. */
enum class Mode {
    /** Aucune limite de temps. */
    LIBRE,

    /** Sessions de X minutes, séparées par une pause de Y minutes. */
    SESSIONS,

    /** Instagram ne s'ouvre pas du tout. */
    BLOQUE,
}

data class Regle(
    val mode: Mode = Mode.LIBRE,
    /** Durée d'une session, en minutes d'utilisation réelle (mode SESSIONS). */
    val sessionMin: Int = 10,
    /** Pause imposée après une session, en minutes (mode SESSIONS). */
    val pauseMin: Int = 30,
    /** Nombre maximum de sessions par jour dans cette phase. 0 = illimité. */
    val maxSessions: Int = 0,
    /** Ferme les Reels / Shorts, même quand le reste de l'appli est autorisé. */
    val bloquerShorts: Boolean = false,
)

/**
 * Une plage horaire avec sa règle.
 * [jours] : 1 = lundi … 7 = dimanche. [debutMin] et [finMin] : minutes depuis minuit.
 * Si fin <= début, la plage passe minuit (22:00 → 07:00). Si début == fin : journée entière.
 */
data class Phase(
    val id: String,
    val nom: String,
    val jours: Set<Int>,
    val debutMin: Int,
    val finMin: Int,
    val regle: Regle,
) {
    fun couvre(t: LocalDateTime): Boolean {
        val jour = t.dayOfWeek.value
        val minute = t.hour * 60 + t.minute
        if (debutMin == finMin) return jour in jours
        if (debutMin < finMin) return jour in jours && minute in debutMin until finMin
        val veille = if (jour == 1) 7 else jour - 1
        return (jour in jours && minute >= debutMin) || (veille in jours && minute < finMin)
    }
}

data class Config(
    /** Dans l'ordre de priorité : la première phase qui couvre l'instant gagne. */
    val phases: List<Phase> = emptyList(),
    /** Règle appliquée quand aucune phase ne couvre l'instant. */
    val defaut: Regle = Regle(),
    /** Mode strict : réglages verrouillés tant qu'Instagram est bloqué. */
    val strict: Boolean = false,
    /** Applique aussi le blocage des Shorts à YouTube. */
    val shortsYoutube: Boolean = false,
)

/** Ce que l'appli retient entre deux ouvertures d'Instagram. */
data class Etat(
    /** Phase dans laquelle la session en cours a démarré (null = pas de session). */
    val sessionPhase: String? = null,
    val utiliseMs: Long = 0,
    val dernierUsage: Long = 0,
    val pauseJusqua: Long = 0,
    /** Jour (epochDay) auquel se rapporte [sessionsDuJour]. */
    val jour: Long = 0,
    val sessionsDuJour: Map<String, Int> = emptyMap(),
)

enum class Raison { PHASE, PAUSE, QUOTA }

sealed interface Decision {
    /** [resteMs] : temps restant dans la session, null si pas de limite. */
    data class Autorise(val resteMs: Long?) : Decision

    /** [jusqua] : instant (epoch ms) de fin du blocage, null si inconnu. */
    data class Bloque(val raison: Raison, val jusqua: Long?) : Decision
}
