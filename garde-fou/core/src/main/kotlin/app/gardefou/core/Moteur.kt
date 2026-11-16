package app.gardefou.core

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** Toute la logique de décision. Aucune dépendance Android : voir MoteurTest. */
object Moteur {
    const val ID_DEFAUT = "defaut"

    fun phaseCourante(config: Config, t: LocalDateTime): Phase? =
        config.phases.firstOrNull { it.couvre(t) }

    fun regleCourante(config: Config, t: LocalDateTime): Regle =
        phaseCourante(config, t)?.regle ?: config.defaut

    /** Prochain instant où la phase active change (cherche sur 7 jours). */
    fun prochainChangement(config: Config, t: LocalDateTime): LocalDateTime? {
        val id = phaseCourante(config, t)?.id
        var c = t.truncatedTo(ChronoUnit.MINUTES)
        repeat(7 * 24 * 60) {
            c = c.plusMinutes(1)
            if (phaseCourante(config, c)?.id != id) return c
        }
        return null
    }

    /**
     * Décide si Instagram est autorisé à l'instant [maintenant] (epoch ms).
     *
     * [deltaMs] : temps passé sur Instagram depuis le dernier appel.
     * [demarrer] : true quand Instagram est réellement à l'écran (ça démarre et
     * consomme les sessions) ; false pour simplement afficher le statut.
     */
    fun evaluer(
        config: Config,
        etat: Etat,
        maintenant: Long,
        zone: ZoneId,
        deltaMs: Long = 0,
        demarrer: Boolean = true,
    ): Pair<Etat, Decision> {
        val t = Instant.ofEpochMilli(maintenant).atZone(zone).toLocalDateTime()
        val jour = t.toLocalDate().toEpochDay()
        var e = if (etat.jour != jour) etat.copy(jour = jour, sessionsDuJour = emptyMap()) else etat

        val phase = phaseCourante(config, t)
        val id = phase?.id ?: ID_DEFAUT
        val regle = phase?.regle ?: config.defaut
        val finDePhase = { prochainChangement(config, t)?.atZone(zone)?.toInstant()?.toEpochMilli() }

        when (regle.mode) {
            Mode.LIBRE -> return e to Decision.Autorise(null)
            Mode.BLOQUE -> return e to Decision.Bloque(Raison.PHASE, finDePhase())
            Mode.SESSIONS -> {}
        }

        if (maintenant < e.pauseJusqua) return e to Decision.Bloque(Raison.PAUSE, e.pauseJusqua)

        val dureeMs = regle.sessionMin.coerceAtLeast(1) * 60_000L
        val pauseMs = regle.pauseMin.coerceAtLeast(0) * 60_000L
        // Une session entamée reste disponible tant qu'on ne s'est pas absenté plus
        // longtemps que la pause : au-delà, on repart sur une session neuve.
        val enCours = e.sessionPhase == id &&
            maintenant - e.dernierUsage < pauseMs.coerceAtLeast(60_000L)

        if (!enCours) {
            val dejaFaites = e.sessionsDuJour[id] ?: 0
            if (regle.maxSessions > 0 && dejaFaites >= regle.maxSessions) {
                return e to Decision.Bloque(Raison.QUOTA, finDePhase())
            }
            if (!demarrer) return e to Decision.Autorise(dureeMs)
            e = e.copy(
                sessionPhase = id,
                utiliseMs = 0,
                dernierUsage = maintenant,
                sessionsDuJour = e.sessionsDuJour + (id to dejaFaites + 1),
            )
        }
        if (!demarrer) return e to Decision.Autorise(dureeMs - e.utiliseMs)

        val utilise = e.utiliseMs + deltaMs.coerceAtLeast(0)
        if (utilise >= dureeMs) {
            e = e.copy(sessionPhase = null, utiliseMs = 0, dernierUsage = maintenant, pauseJusqua = maintenant + pauseMs)
            return e to Decision.Bloque(Raison.PAUSE, e.pauseJusqua)
        }
        e = e.copy(utiliseMs = utilise, dernierUsage = maintenant)
        return e to Decision.Autorise(dureeMs - utilise)
    }
}
