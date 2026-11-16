package app.gardefou.core

import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MoteurTest {
    private val zone = ZoneId.of("Europe/Paris")
    private val config = Defauts.config()
    private val min = 60_000L

    // Le 16 novembre 2026 est un lundi.
    private fun a(jour: Int, h: Int, m: Int = 0) =
        LocalDateTime.of(2026, 11, jour, h, m).atZone(zone).toInstant().toEpochMilli()

    /** Simule [minutes] d'Instagram à l'écran, un tick par seconde. */
    private fun utiliser(c: Config, depart: Etat, debut: Long, minutes: Int): Triple<Etat, Decision, Long> {
        var (e, d) = Moteur.evaluer(c, depart, debut, zone, 0)
        var t = debut
        repeat(minutes * 60) {
            if (d is Decision.Bloque) return Triple(e, d, t)
            t += 1000
            val r = Moteur.evaluer(c, e, t, zone, 1000)
            e = r.first; d = r.second
        }
        return Triple(e, d, t)
    }

    @Test fun `choisit la phase selon le jour et l'heure`() {
        assertEquals("travail-matin", Moteur.phaseCourante(config, LocalDateTime.of(2026, 11, 16, 10, 0))?.id)
        assertEquals("midi", Moteur.phaseCourante(config, LocalDateTime.of(2026, 11, 16, 12, 0))?.id)
        // Samedi matin : aucune phase, donc règle par défaut.
        assertNull(Moteur.phaseCourante(config, LocalDateTime.of(2026, 11, 21, 10, 0)))
    }

    @Test fun `une phase peut passer minuit`() {
        val nuit = Phase("nuit", "Nuit", setOf(1), 22 * 60, 7 * 60, Regle(Mode.BLOQUE))
        assertTrue(nuit.couvre(LocalDateTime.of(2026, 11, 16, 23, 0)))
        assertTrue(nuit.couvre(LocalDateTime.of(2026, 11, 17, 6, 59)))
        assertTrue(!nuit.couvre(LocalDateTime.of(2026, 11, 17, 7, 0)))
        assertTrue(!nuit.couvre(LocalDateTime.of(2026, 11, 17, 23, 0)))
    }

    @Test fun `heures de travail bloquees jusqu'a midi`() {
        val (_, d) = Moteur.evaluer(config, Etat(), a(16, 10), zone)
        assertEquals(Decision.Bloque(Raison.PHASE, a(16, 12)), d)
    }

    @Test fun `session de 10 minutes puis pause de 20`() {
        val (e, d, fin) = utiliser(config, Etat(), a(16, 12), 30)
        assertEquals(a(16, 12, 10), fin)
        assertEquals(Decision.Bloque(Raison.PAUSE, a(16, 12, 30)), d)
        // Toujours bloqué pendant la pause, de nouveau autorisé après.
        assertIs<Decision.Bloque>(Moteur.evaluer(config, e, a(16, 12, 29), zone).second)
        assertEquals(Decision.Autorise(10 * min), Moteur.evaluer(config, e, a(16, 12, 30), zone).second)
    }

    @Test fun `une session entamee se reprend, puis se remet a zero apres une longue absence`() {
        val (e, d, _) = utiliser(config, Etat(), a(16, 19), 5)
        assertEquals(Decision.Autorise(10 * min), d)
        // 30 minutes plus tard (< pause de 60) : il reste 10 minutes.
        assertEquals(Decision.Autorise(10 * min), Moteur.evaluer(config, e, a(16, 19, 35), zone, 0).second)
        // 2 heures plus tard : session neuve de 15 minutes.
        assertEquals(Decision.Autorise(15 * min), Moteur.evaluer(config, e, a(16, 21, 5), zone, 0).second)
    }

    @Test fun `consulter le statut ne demarre pas de session`() {
        val (e, d) = Moteur.evaluer(config, Etat(), a(16, 19), zone, demarrer = false)
        assertEquals(Decision.Autorise(15 * min), d)
        assertNull(e.sessionPhase)
        assertTrue(e.sessionsDuJour.isEmpty())
    }

    @Test fun `quota de sessions par jour`() {
        val c = config.copy(phases = listOf(
            Phase("soir", "Soir", setOf(1, 2), 18 * 60, 23 * 60, Regle(Mode.SESSIONS, 15, 60, maxSessions = 1)),
        ))
        val (e, _, _) = utiliser(c, Etat(), a(16, 18), 20)
        assertEquals(Decision.Bloque(Raison.QUOTA, a(16, 23)), Moteur.evaluer(c, e, a(16, 20), zone).second)
        // Le lendemain, le compteur repart de zéro.
        assertIs<Decision.Autorise>(Moteur.evaluer(c, e, a(17, 18), zone).second)
    }

    @Test fun `la fin de la phase coupe la session en cours`() {
        val (e, _, _) = utiliser(config, Etat(), a(16, 13, 55), 4)
        assertEquals(Decision.Bloque(Raison.PHASE, a(16, 18)), Moteur.evaluer(config, e, a(16, 14), zone, 1000).second)
    }
}
