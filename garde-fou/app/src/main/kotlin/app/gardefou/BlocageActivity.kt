package app.gardefou

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.gardefou.core.Raison
import kotlinx.coroutines.delay

/** L'écran qui passe par-dessus Instagram quand il est bloqué. */
class BlocageActivity : ComponentActivity() {
    private var raison by mutableStateOf(Raison.PHASE)
    private var jusqua by mutableLongStateOf(0L)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        lire(intent)
        setContent {
            ThemeGardeFou {
                BackHandler { allerAccueil() }
                Ecran()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        lire(intent)
    }

    private fun lire(intent: Intent) {
        raison = runCatching { Raison.valueOf(intent.getStringExtra(RAISON) ?: "") }.getOrDefault(Raison.PHASE)
        jusqua = intent.getLongExtra(JUSQUA, 0L)
    }

    /** Renvoie sur l'écran d'accueil du téléphone (et pas sur Instagram, qui est dessous). */
    private fun allerAccueil() {
        startActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        finish()
    }

    @androidx.compose.runtime.Composable
    private fun Ecran() {
        var maintenant by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(Unit) {
            while (true) {
                delay(1000)
                maintenant = System.currentTimeMillis()
            }
        }
        val titre = when (raison) {
            Raison.PAUSE -> "Session terminée"
            Raison.QUOTA -> "Plus de session pour l'instant"
            Raison.PHASE -> "Instagram est fermé"
        }
        val detail = when {
            jusqua <= 0L -> "Pas de réouverture prévue par tes règles."
            jusqua <= maintenant -> "C'est de nouveau ouvert."
            else -> "Retour possible à ${heure(jusqua)}\n(dans ${duree(jusqua - maintenant)})"
        }
        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier.safeDrawingPadding().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("⏳", fontSize = 64.sp)
                Spacer(Modifier.height(24.dp))
                Text(titre, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Text(detail, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                Spacer(Modifier.height(32.dp))
                Button(onClick = { allerAccueil() }) { Text("OK, je fais autre chose") }
            }
        }
    }

    companion object {
        const val RAISON = "raison"
        const val JUSQUA = "jusqua"
    }
}
