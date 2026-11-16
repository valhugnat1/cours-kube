package app.gardefou

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.gardefou.core.Config
import app.gardefou.core.Defauts
import app.gardefou.core.Etat
import app.gardefou.core.Mode
import app.gardefou.core.Phase
import app.gardefou.core.Regle
import org.json.JSONArray
import org.json.JSONObject

class GardeFouApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Depot.init(this)
    }
}

/**
 * Les réglages et l'état, gardés en mémoire et sauvegardés en JSON dans les
 * SharedPreferences. L'écran et le service tournent dans le même processus : ils
 * partagent donc cet objet, et l'écran se met à jour tout seul (états Compose).
 */
object Depot {
    private lateinit var prefs: SharedPreferences

    var config by mutableStateOf(Config())
        private set
    var etat by mutableStateOf(Etat())
        private set

    fun init(contexte: Context) {
        prefs = contexte.getSharedPreferences("gardefou", Context.MODE_PRIVATE)
        config = prefs.getString("config", null)
            ?.let { runCatching { lireConfig(JSONObject(it)) }.getOrNull() }
            ?: Defauts.config()
        etat = prefs.getString("etat", null)
            ?.let { runCatching { lireEtat(JSONObject(it)) }.getOrNull() }
            ?: Etat()
    }

    fun enregistrerConfig(c: Config) {
        config = c
        prefs.edit().putString("config", ecrireConfig(c).toString()).apply()
    }

    fun enregistrerEtat(e: Etat) {
        if (e == etat) return
        etat = e
        prefs.edit().putString("etat", ecrireEtat(e).toString()).apply()
    }

    // ---------- JSON ----------

    private fun ecrireRegle(r: Regle) = JSONObject()
        .put("mode", r.mode.name)
        .put("sessionMin", r.sessionMin)
        .put("pauseMin", r.pauseMin)
        .put("maxSessions", r.maxSessions)
        .put("bloquerShorts", r.bloquerShorts)

    private fun lireRegle(o: JSONObject) = Regle(
        mode = runCatching { Mode.valueOf(o.getString("mode")) }.getOrDefault(Mode.LIBRE),
        sessionMin = o.optInt("sessionMin", 10),
        pauseMin = o.optInt("pauseMin", 30),
        maxSessions = o.optInt("maxSessions", 0),
        bloquerShorts = o.optBoolean("bloquerShorts", false),
    )

    private fun ecrireConfig(c: Config) = JSONObject()
        .put("phases", JSONArray().also { tableau ->
            c.phases.forEach { p ->
                tableau.put(
                    JSONObject()
                        .put("id", p.id)
                        .put("nom", p.nom)
                        .put("jours", JSONArray(p.jours.sorted()))
                        .put("debut", p.debutMin)
                        .put("fin", p.finMin)
                        .put("regle", ecrireRegle(p.regle))
                )
            }
        })
        .put("defaut", ecrireRegle(c.defaut))
        .put("strict", c.strict)
        .put("shortsYoutube", c.shortsYoutube)

    private fun lireConfig(o: JSONObject): Config {
        val tableau = o.getJSONArray("phases")
        val phases = (0 until tableau.length()).map { i ->
            val p = tableau.getJSONObject(i)
            val jours = p.getJSONArray("jours")
            Phase(
                id = p.getString("id"),
                nom = p.getString("nom"),
                jours = (0 until jours.length()).map { jours.getInt(it) }.toSet(),
                debutMin = p.getInt("debut"),
                finMin = p.getInt("fin"),
                regle = lireRegle(p.getJSONObject("regle")),
            )
        }
        return Config(
            phases = phases,
            defaut = lireRegle(o.getJSONObject("defaut")),
            strict = o.optBoolean("strict", false),
            shortsYoutube = o.optBoolean("shortsYoutube", false),
        )
    }

    private fun ecrireEtat(e: Etat) = JSONObject()
        .put("sessionPhase", e.sessionPhase ?: JSONObject.NULL)
        .put("utiliseMs", e.utiliseMs)
        .put("dernierUsage", e.dernierUsage)
        .put("pauseJusqua", e.pauseJusqua)
        .put("jour", e.jour)
        .put("sessions", JSONObject().also { s -> e.sessionsDuJour.forEach { (id, n) -> s.put(id, n) } })

    private fun lireEtat(o: JSONObject): Etat {
        val sessions = o.optJSONObject("sessions") ?: JSONObject()
        return Etat(
            sessionPhase = if (o.isNull("sessionPhase")) null else o.getString("sessionPhase"),
            utiliseMs = o.optLong("utiliseMs"),
            dernierUsage = o.optLong("dernierUsage"),
            pauseJusqua = o.optLong("pauseJusqua"),
            jour = o.optLong("jour"),
            sessionsDuJour = sessions.keys().asSequence().associateWith { sessions.getInt(it) },
        )
    }
}
