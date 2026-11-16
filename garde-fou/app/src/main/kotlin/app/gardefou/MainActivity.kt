@file:OptIn(ExperimentalMaterial3Api::class)

package app.gardefou

import android.app.TimePickerDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.gardefou.core.Decision
import app.gardefou.core.Mode
import app.gardefou.core.Moteur
import app.gardefou.core.Phase
import app.gardefou.core.Raison
import app.gardefou.core.Regle
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ThemeGardeFou { Appli() } }
    }
}

/** Ce qu'on est en train de modifier (null = écran d'accueil). */
private sealed interface Edition {
    data class DeLaPhase(val phase: Phase, val nouvelle: Boolean) : Edition
    data object DuDefaut : Edition
}

@Composable
private fun Appli() {
    var edition by remember { mutableStateOf<Edition?>(null) }
    val config = Depot.config

    when (val e = edition) {
        null -> Accueil(
            surPhase = { edition = Edition.DeLaPhase(it, nouvelle = false) },
            surNouvellePhase = {
                val vierge = Phase(
                    UUID.randomUUID().toString(), "Nouvelle phase", setOf(1, 2, 3, 4, 5, 6, 7),
                    12 * 60, 14 * 60, Regle(Mode.SESSIONS),
                )
                edition = Edition.DeLaPhase(vierge, nouvelle = true)
            },
            surDefaut = { edition = Edition.DuDefaut },
        )

        is Edition.DeLaPhase -> EcranPhase(
            depart = e.phase,
            nouvelle = e.nouvelle,
            enregistrer = { p ->
                val phases = if (e.nouvelle) config.phases + p else config.phases.map { if (it.id == p.id) p else it }
                Depot.enregistrerConfig(config.copy(phases = phases))
                edition = null
            },
            supprimer = {
                Depot.enregistrerConfig(config.copy(phases = config.phases.filter { it.id != e.phase.id }))
                edition = null
            },
            retour = { edition = null },
        )

        Edition.DuDefaut -> EcranDefaut(
            depart = config.defaut,
            enregistrer = {
                Depot.enregistrerConfig(config.copy(defaut = it))
                edition = null
            },
            retour = { edition = null },
        )
    }
}

// ---------------------------------------------------------------- Accueil

@Composable
private fun Accueil(surPhase: (Phase) -> Unit, surNouvellePhase: () -> Unit, surDefaut: () -> Unit) {
    val contexte = LocalContext.current
    val config = Depot.config
    val zone = ZoneId.systemDefault()

    var maintenant by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var actif by remember { mutableStateOf(serviceActif(contexte)) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            maintenant = System.currentTimeMillis()
            actif = serviceActif(contexte)
        }
    }

    val t = Instant.ofEpochMilli(maintenant).atZone(zone).toLocalDateTime()
    val phaseActive = Moteur.phaseCourante(config, t)
    val decision = Moteur.evaluer(config, Depot.etat, maintenant, zone, demarrer = false).second
    val verrouille = config.strict && decision is Decision.Bloque

    Scaffold(topBar = { TopAppBar(title = { Text("Garde-fou") }) }) { marges ->
        Column(
            Modifier
                .padding(marges)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (!actif) CarteActivation()

            // --- Statut ---
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = if (decision is Decision.Bloque) MaterialTheme.colorScheme.errorContainer
                    else MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("En ce moment", style = MaterialTheme.typography.labelLarge)
                    Text(phaseActive?.nom ?: "Hors phase (règle par défaut)", style = MaterialTheme.typography.titleLarge)
                    Text(texteStatut(decision, maintenant))
                    if ((phaseActive?.regle ?: config.defaut).let { it.bloquerShorts && it.mode != Mode.BLOQUE }) {
                        Text("Reels bloqués")
                    }
                }
            }

            if (verrouille) {
                Text(
                    "Mode strict : réglages verrouillés tant qu'Instagram est bloqué.",
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // --- Phases ---
            Text("Phases", style = MaterialTheme.typography.titleMedium)
            Text(
                "Si deux phases se chevauchent, celle du haut gagne.",
                style = MaterialTheme.typography.bodySmall,
            )
            config.phases.forEachIndexed { i, phase ->
                Card(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !verrouille) { surPhase(phase) },
                ) {
                    Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                phase.nom + if (phase.id == phaseActive?.id) "  ● active" else "",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text("${texteJours(phase.jours)} · ${texteHoraire(phase)}")
                            Text(texteRegle(phase.regle), style = MaterialTheme.typography.bodySmall)
                        }
                        Column {
                            TextButton(
                                enabled = !verrouille && i > 0,
                                onClick = { Depot.enregistrerConfig(config.copy(phases = config.phases.echanger(i, i - 1))) },
                            ) { Text("▲") }
                            TextButton(
                                enabled = !verrouille && i < config.phases.lastIndex,
                                onClick = { Depot.enregistrerConfig(config.copy(phases = config.phases.echanger(i, i + 1))) },
                            ) { Text("▼") }
                        }
                    }
                }
            }
            OutlinedButton(onClick = surNouvellePhase, enabled = !verrouille, modifier = Modifier.fillMaxWidth()) {
                Text("+ Ajouter une phase")
            }

            // --- Règle par défaut ---
            Text("Le reste du temps", style = MaterialTheme.typography.titleMedium)
            Card(
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = !verrouille) { surDefaut() },
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("Règle par défaut", style = MaterialTheme.typography.titleMedium)
                    Text(texteRegle(config.defaut), style = MaterialTheme.typography.bodySmall)
                }
            }

            // --- Options ---
            Text("Options", style = MaterialTheme.typography.titleMedium)
            LigneSwitch(
                titre = "Shorts YouTube aussi",
                detail = "Quand les Reels sont bloqués, les Shorts YouTube le sont aussi.",
                coche = config.shortsYoutube,
                actif = !verrouille,
            ) { Depot.enregistrerConfig(config.copy(shortsYoutube = it)) }
            LigneSwitch(
                titre = "Mode strict",
                detail = "Impossible de changer les règles pendant qu'Instagram est bloqué.",
                coche = config.strict,
                actif = !verrouille,
            ) { Depot.enregistrerConfig(config.copy(strict = it)) }
        }
    }
}

private fun texteStatut(decision: Decision, maintenant: Long): String = when (decision) {
    is Decision.Autorise ->
        decision.resteMs?.let { "Instagram autorisé · session : ${duree(it)} restantes" } ?: "Instagram autorisé, sans limite"

    is Decision.Bloque -> {
        val quoi = when (decision.raison) {
            Raison.PAUSE -> "Pause entre deux sessions"
            Raison.QUOTA -> "Sessions du jour épuisées"
            Raison.PHASE -> "Instagram bloqué"
        }
        decision.jusqua?.let { "$quoi · jusqu'à ${heure(it)} (${duree(it - maintenant)})" } ?: quoi
    }
}

private fun <T> List<T>.echanger(i: Int, j: Int): List<T> =
    toMutableList().also { val x = it[i]; it[i] = it[j]; it[j] = x }

@Composable
private fun CarteActivation() {
    val contexte = LocalContext.current
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("À activer : le service d'accessibilité", style = MaterialTheme.typography.titleMedium)
            Text(
                "Sans lui, Garde-fou ne voit pas qu'Instagram est ouvert et ne bloque rien.\n\n" +
                    "1. Si « Garde-fou » est grisé dans la liste : ouvre les infos de l'appli, menu ⋮ en haut à droite, " +
                    "« Autoriser les paramètres restreints ».\n" +
                    "2. Accessibilité → Applis installées (ou téléchargées) → Garde-fou → activer.",
            )
            Button(onClick = { contexte.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }) {
                Text("Ouvrir l'accessibilité")
            }
            OutlinedButton(onClick = {
                contexte.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${contexte.packageName}"))
                )
            }) { Text("Infos de l'appli") }
        }
    }
}

@Composable
private fun LigneSwitch(titre: String, detail: String, coche: Boolean, actif: Boolean = true, surChangement: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(titre)
            Text(detail, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = coche, onCheckedChange = surChangement, enabled = actif)
    }
}

// ---------------------------------------------------------------- Édition

@Composable
private fun EcranPhase(
    depart: Phase,
    nouvelle: Boolean,
    enregistrer: (Phase) -> Unit,
    supprimer: () -> Unit,
    retour: () -> Unit,
) {
    val contexte = LocalContext.current
    var phase by remember { mutableStateOf(depart) }
    BackHandler(onBack = retour)

    fun choisirHeure(minutes: Int, surChoix: (Int) -> Unit) {
        TimePickerDialog(contexte, { _, h, m -> surChoix(h * 60 + m) }, minutes / 60, minutes % 60, true).show()
    }

    Scaffold(topBar = { TopAppBar(title = { Text(if (nouvelle) "Nouvelle phase" else "Modifier la phase") }) }) { marges ->
        Column(
            Modifier
                .padding(marges)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = phase.nom,
                onValueChange = { phase = phase.copy(nom = it) },
                label = { Text("Nom") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Text("Jours", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                NOMS_JOURS.forEachIndexed { i, nom ->
                    val jour = i + 1
                    FilterChip(
                        selected = jour in phase.jours,
                        onClick = {
                            phase = phase.copy(jours = if (jour in phase.jours) phase.jours - jour else phase.jours + jour)
                        },
                        label = { Text(nom) },
                    )
                }
            }

            Text("Horaire", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { choisirHeure(phase.debutMin) { phase = phase.copy(debutMin = it) } }) {
                    Text("De ${heureDuJour(phase.debutMin)}")
                }
                OutlinedButton(onClick = { choisirHeure(phase.finMin) { phase = phase.copy(finMin = it) } }) {
                    Text("à ${heureDuJour(phase.finMin)}")
                }
            }
            Text(
                when {
                    phase.debutMin == phase.finMin -> "Même heure de début et de fin : toute la journée."
                    phase.debutMin > phase.finMin -> "La phase passe minuit et se termine le lendemain."
                    else -> ""
                },
                style = MaterialTheme.typography.bodySmall,
            )

            EditeurRegle(phase.regle) { phase = phase.copy(regle = it) }

            Button(
                onClick = { enregistrer(phase.copy(nom = phase.nom.trim().ifEmpty { "Phase" })) },
                enabled = phase.jours.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Enregistrer") }
            if (!nouvelle) {
                TextButton(onClick = supprimer, modifier = Modifier.fillMaxWidth()) {
                    Text("Supprimer cette phase", color = MaterialTheme.colorScheme.error)
                }
            }
            TextButton(onClick = retour, modifier = Modifier.fillMaxWidth()) { Text("Annuler") }
        }
    }
}

@Composable
private fun EcranDefaut(depart: Regle, enregistrer: (Regle) -> Unit, retour: () -> Unit) {
    var regle by remember { mutableStateOf(depart) }
    BackHandler(onBack = retour)
    Scaffold(topBar = { TopAppBar(title = { Text("Règle par défaut") }) }) { marges ->
        Column(
            Modifier
                .padding(marges)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Elle s'applique quand aucune phase ne couvre l'heure qu'il est.")
            EditeurRegle(regle) { regle = it }
            Button(onClick = { enregistrer(regle) }, modifier = Modifier.fillMaxWidth()) { Text("Enregistrer") }
            TextButton(onClick = retour, modifier = Modifier.fillMaxWidth()) { Text("Annuler") }
        }
    }
}

@Composable
private fun EditeurRegle(regle: Regle, surChangement: (Regle) -> Unit) {
    Text("Instagram", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf(Mode.LIBRE to "Libre", Mode.SESSIONS to "Sessions", Mode.BLOQUE to "Bloqué").forEach { (mode, nom) ->
            FilterChip(
                selected = regle.mode == mode,
                onClick = { surChangement(regle.copy(mode = mode)) },
                label = { Text(nom) },
            )
        }
    }

    if (regle.mode == Mode.SESSIONS) {
        ChampNombre("Durée d'une session (minutes)", regle.sessionMin) { surChangement(regle.copy(sessionMin = it.coerceAtLeast(1))) }
        ChampNombre("Pause avant la suivante (minutes)", regle.pauseMin) { surChangement(regle.copy(pauseMin = it)) }
        ChampNombre("Sessions max par jour (0 = illimité)", regle.maxSessions) { surChangement(regle.copy(maxSessions = it)) }
        Text(
            "Le temps ne compte que quand Instagram est à l'écran. Une session entamée se reprend ; " +
                "elle repart de zéro si tu n'y touches pas pendant la durée de la pause.",
            style = MaterialTheme.typography.bodySmall,
        )
    }

    if (regle.mode != Mode.BLOQUE) {
        LigneSwitch(
            titre = "Bloquer les Reels",
            detail = "Le reste d'Instagram (messages, fil, stories) reste accessible.",
            coche = regle.bloquerShorts,
        ) { surChangement(regle.copy(bloquerShorts = it)) }
    }
}

@Composable
private fun ChampNombre(titre: String, valeur: Int, surChangement: (Int) -> Unit) {
    var texte by remember { mutableStateOf(valeur.toString()) }
    OutlinedTextField(
        value = texte,
        onValueChange = { saisie ->
            texte = saisie.filter { it.isDigit() }.take(4)
            texte.toIntOrNull()?.let(surChangement)
        },
        label = { Text(titre) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth(),
    )
}
