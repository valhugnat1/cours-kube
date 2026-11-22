// Robot des précisions à la demande, lancé par .github/workflows/precision.yml.
// Lit la demande sur le site, fait rédiger la précision par Claude Code (abonnement, via
// CLAUDE_CODE_OAUTH_TOKEN), remonte l'avancement en direct, puis envoie la réponse.
//
//   node scripts/precision-robot.mjs demarrer   -> signale au site que le robot est réveillé
//   node scripts/precision-robot.mjs            -> rédige et envoie la précision
//   node scripts/precision-robot.mjs echec      -> signale un échec du workflow

import { spawn } from 'node:child_process';

const { PRECISION_ID, ORIGINE, SITE_URL, ROBOT_SECRET, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, RUN_URL } = process.env;
const MODELE = process.env.MODELE || 'sonnet';
const mode = process.argv[2] ?? 'rediger';

if (!PRECISION_ID || !/^[\w-]+$/.test(PRECISION_ID)) sortir('identifiant de précision absent ou invalide');
if (!ROBOT_SECRET) sortir('secret ROBOT_SECRET absent');
const base = origineAutorisee(ORIGINE);

/** Le robot n'envoie son secret qu'au site, ou à un aperçu de branche du même Worker. */
function origineAutorisee(o) {
  let url;
  try { url = new URL(o); } catch { sortir(`origine invalide : ${o}`); }
  if (['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin; // essais avec wrangler dev
  if (url.protocol !== 'https:') sortir(`origine non https : ${o}`);
  if (SITE_URL) {
    const site = new URL(SITE_URL).hostname;
    if (url.hostname !== site && !url.hostname.endsWith(`-${site}`)) sortir(`origine ${url.hostname} hors du site ${site}`);
  } else if (!url.hostname.endsWith('.workers.dev')) {
    sortir(`origine ${url.hostname} refusée (définis la variable SITE_URL du dépôt pour un domaine perso)`);
  }
  return url.origin;
}

function sortir(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}

async function api(method, corps) {
  const headers = { authorization: `Bearer ${ROBOT_SECRET}`, 'content-type': 'application/json', 'user-agent': 'cours-kube-robot' };
  if (CF_ACCESS_CLIENT_ID) {
    headers['cf-access-client-id'] = CF_ACCESS_CLIENT_ID;
    headers['cf-access-client-secret'] = CF_ACCESS_CLIENT_SECRET ?? '';
  }
  const r = await fetch(`${base}/api/robot/precisions/${PRECISION_ID}`, {
    method, headers, body: corps ? JSON.stringify(corps) : undefined, redirect: 'manual',
  });
  if (r.status === 410) return { annulee: true };
  if (r.status >= 300 && r.status < 400) throw new Error(`redirigé (HTTP ${r.status}) : Cloudflare Access bloque le robot, vérifie le service token`);
  if (!r.ok) throw new Error(`le site répond HTTP ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const NIVEAUX = {
  zero: "Il ne connaît PAS DU TOUT cette notion. Pars de zéro : ce que c'est en une phrase simple, une image du quotidien, pourquoi ça existe, puis le lien avec la leçon. Chaque mot technique que tu utilises, tu l'expliques en quelques mots. 120 à 250 mots.",
  details: "Il voit l'idée mais veut PLUS DE DÉTAILS : le mécanisme, qui fait quoi, dans quel ordre, ce qui se passe concrètement dans le cluster. Niveau architecte : le fonctionnement, pas la liste exhaustive des options. 150 à 300 mots.",
  exemple: "Il veut UN EXEMPLE CONCRET : un cas chez un client de la plateforme LLM (noms de pods, namespaces, valeurs plausibles), ce qu'on observe, ce que ça change pour lui. 120 à 250 mots.",
  autrement: "L'explication de la leçon ne lui parle pas : EXPLIQUE AUTREMENT, sous un autre angle, avec une autre image, et si possible un petit schéma. Ne répète pas la formulation de la leçon. 120 à 250 mots.",
};

function consigne(d) {
  const [dossier] = d.lecon.split('/');
  const numero = dossier.slice(0, 2);
  const lignes = [
    "Tu aides Hugo, solution architect qui apprend Kubernetes et Helm pour déployer une plateforme LLM chez des clients (on-prem, GCP, private cloud, air-gapped). Il lit son cours sur téléphone, par sessions de 5 minutes.",
    '',
    `Il lit la leçon \`src/content/lecons/${d.lecon}.mdx\` (étape ${Number(numero)}). Il a sélectionné ce passage et demande une explication :`,
    `« ${d.passage} »`,
  ];
  if (d.contexte && d.contexte !== d.passage) lignes.push('', `Le paragraphe autour du passage : « ${d.contexte} »`);
  lignes.push('', `Ce qu'il veut : ${NIVEAUX[d.niveau] ?? NIVEAUX.details}`);
  if (d.question) lignes.push('', `Sa question, avec ses mots : « ${d.question} »`);
  if (d.precedente?.reponse) {
    lignes.push('', 'Tu lui as déjà donné cette précision sur le même passage, elle ne lui a pas suffi. Ne la répète pas, va plus loin dans la direction demandée :', '"""', d.precedente.reponse, '"""');
  }
  if (d.deja_demande?.length) {
    lignes.push('', `Dans cette leçon, il a déjà demandé des précisions sur : ${d.deja_demande.map((x) => `« ${x.passage} »`).join(', ')}. Ces notions sont fragiles pour lui : n'en dépends pas sans les rappeler.`);
  }
  lignes.push(
    '',
    'Méthode :',
    `1. Lis la leçon, puis la source de l'étape : \`sources/etape-${numero}-*.md\` (cherche le passage avec Grep). La source est la vérité : ne la contredis pas et n'invente pas de faits techniques. Un fait hors source doit être standard, sûr et marginal.`,
    "2. Si la leçon a une analogie (encadré `<Analogie>`), reprends son univers quand c'est naturel, sauf si on te demande d'expliquer autrement.",
    '3. Réponds en français, en tutoyant Hugo, phrases courtes, mots simples.',
    '',
    'Format de ta réponse finale : UNIQUEMENT la précision, sans préambule (« Voici… ») ni conclusion de politesse.',
    '- Markdown simple : paragraphes, **gras** pour les mots-clés, `code` pour les noms d’objets et de commandes, listes à tirets, au plus un petit tableau.',
    '- Pas de titres (#), pas de HTML, pas de liens.',
    '- Si un schéma aide vraiment : au plus un bloc ```mermaid en `flowchart TD`, 3 à 7 nœuds, labels entre guillemets doubles, noms concrets, et une classe de rôle par nœud parmi :::ext (qui appelle), :::regle (la règle écrite), :::moteur (qui agit), :::cible (le résultat), :::ko (ce qui échoue).',
    '- Termine par une phrase « En bref : … » qui résume.',
  );
  return lignes.join('\n');
}

/** Ce que Claude est en train de faire, en mots lisibles sur le téléphone. */
function decrire(outil, entree = {}) {
  const fichier = (entree.file_path ?? entree.path ?? '').replace(/^.*?(src\/|sources\/)/, '$1');
  if (outil === 'Read') return fichier.startsWith('sources/') ? `Claude lit la source : ${fichier}` : `Claude relit la leçon : ${fichier.split('/').pop()}`;
  if (outil === 'Grep') return `Claude cherche « ${String(entree.pattern ?? '').slice(0, 40)} » dans le cours`;
  if (outil === 'Glob') return 'Claude repère les fichiers du cours';
  return `Claude utilise ${outil}`;
}

async function rediger() {
  const d = await api('GET');
  if (d.annulee) { console.log('Demande supprimée entre-temps, rien à faire.'); return; }

  let derniere = '';
  let dernierEnvoi = 0;
  let annulee = false;
  let enCours = Promise.resolve();
  const signaler = (corps, forcer = false) => {
    const cle = `${corps.statut ?? ''}|${corps.activite ?? ''}`;
    const t = Date.now();
    if (!forcer && (cle === derniere || t - dernierEnvoi < 2500)) return;
    derniere = cle;
    dernierEnvoi = t;
    enCours = enCours.then(() => api('POST', corps)).then((r) => {
      if (r?.annulee) { annulee = true; enfant.kill('SIGTERM'); }
    }).catch((e) => console.error('signalement :', e.message));
  };

  console.log(`Modèle : ${MODELE}\n--- consigne ---\n${consigne(d)}\n---`);
  const enfant = spawn('claude', [
    '-p', consigne(d),
    '--model', MODELE,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '14',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  signaler({ statut: 'redaction', activite: 'Claude ouvre la leçon' }, true);
  let resultat = null;
  let tampon = '';
  enfant.stdout.on('data', (morceau) => {
    tampon += morceau;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const ligne = tampon.slice(0, i).trim();
      tampon = tampon.slice(i + 1);
      if (!ligne) continue;
      let ev;
      try { ev = JSON.parse(ligne); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const bloc of ev.message?.content ?? []) {
          if (bloc.type === 'tool_use') { console.log(`→ ${bloc.name} ${JSON.stringify(bloc.input)}`); signaler({ activite: decrire(bloc.name, bloc.input) }); }
          else if (bloc.type === 'text' && bloc.text.trim()) signaler({ activite: 'Claude rédige ta précision' });
        }
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        console.log(`Claude Code ${ev.claude_code_version ?? ''} · modèle ${ev.model ?? '?'} · authentification ${ev.apiKeySource ?? '?'}`);
      } else if (ev.type === 'result') {
        resultat = ev;
        if (ev.is_error) console.log(`--- résultat en erreur ---\n${JSON.stringify(ev, null, 2)}`);
      }
    }
  });

  const code = await new Promise((ok) => enfant.on('close', ok));
  await enCours;
  if (annulee) { console.log('Demande supprimée pendant la rédaction : arrêt.'); return; }
  if (!resultat || resultat.is_error || code !== 0) {
    const pourquoi = resultat?.subtype === 'error_max_turns' ? 'Claude a tourné trop longtemps sans conclure.'
      : `Claude Code s’est arrêté (code ${code}) : ${String(resultat?.result ?? resultat?.subtype ?? 'sans message').slice(0, 300)}`;
    await api('POST', { statut: 'erreur', erreur: pourquoi });
    sortir(pourquoi);
  }
  const reponse = String(resultat.result ?? '').trim()
    .replace(/^(voici[^\n]*:\s*\n+)/i, '');
  if (!reponse) { await api('POST', { statut: 'erreur', erreur: 'Claude a rendu une réponse vide.' }); sortir('réponse vide'); }
  console.log(`--- précision ---\n${reponse}`);
  await api('POST', { statut: 'prete', reponse });
}

try {
  if (mode === 'demarrer') {
    await api('POST', { statut: 'demarree', activite: 'Robot réveillé : il installe Claude Code', run_url: RUN_URL });
  } else if (mode === 'echec') {
    // Déjà marquée en erreur par l'étape précédente : le site répond 409, rien de plus à dire.
    await api('POST', { statut: 'erreur', erreur: 'Le workflow GitHub a échoué. Ouvre le run pour voir pourquoi.', run_url: RUN_URL }).catch(() => {});
  } else {
    await rediger();
  }
} catch (e) {
  sortir(e.message);
}
