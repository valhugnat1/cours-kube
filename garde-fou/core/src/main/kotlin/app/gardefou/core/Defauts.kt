package app.gardefou.core

/** Réglages proposés à la première ouverture. Tout se modifie dans l'appli. */
object Defauts {
    private val semaine = setOf(1, 2, 3, 4, 5)
    private val tousLesJours = setOf(1, 2, 3, 4, 5, 6, 7)

    fun config() = Config(
        phases = listOf(
            Phase("travail-matin", "Travail (matin)", semaine, 9 * 60, 12 * 60, Regle(Mode.BLOQUE)),
            Phase("midi", "Pause de midi", tousLesJours, 12 * 60, 14 * 60, Regle(Mode.SESSIONS, sessionMin = 10, pauseMin = 20)),
            Phase("travail-aprem", "Travail (après-midi)", semaine, 14 * 60, 18 * 60, Regle(Mode.BLOQUE)),
            Phase("soir", "Soir", tousLesJours, 18 * 60, 23 * 60, Regle(Mode.SESSIONS, sessionMin = 15, pauseMin = 60)),
        ),
        defaut = Regle(Mode.LIBRE, bloquerShorts = true),
    )
}
