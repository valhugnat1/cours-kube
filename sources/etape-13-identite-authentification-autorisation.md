# Étape 13 — Identité, authentification, autorisation

**Objectif** : à la fin de cette étape, tu sais distinguer le chemin d'un humain (navigateur, SSO) de celui d'une machine (clé API), expliquer un flux OIDC sans trou, brancher la plateforme sur l'IdP d'un client, et diagnostiquer un problème de login **sans navigateur**, en séparant « qui es-tu ? » (401) de « as-tu le droit ? » (403).

**Notions couvertes** : §5 (OIDC, authorization code + PKCE, sessions, clés API, realms/tenants, identity brokering OIDC/SAML, comptes locaux, rôles vs ReBAC, diagnostic).

**Prérequis** : étape 6 (RBAC Kubernetes — à ne pas confondre avec l'autorisation applicative), étape 11 (carte), étape 12 (TLS, CA interne, egress).

---

## 13.1 Trois questions, trois mots

| Question | Nom | Échec | Code HTTP |
|---|---|---|---|
| Qui es-tu ? | **Authentification** (authN) | Identité absente, invalide, expirée | **401** Unauthorized (mal nommé : c'est « non authentifié ») |
| As-tu le droit de faire ça, sur ça ? | **Autorisation** (authZ) | Identité valide, permission absente | **403** Forbidden |
| À quelle organisation appartiens-tu ? | **Tenancy** / rattachement | Identité valide, pas (ou mal) rattachée | Variable : 403, 404 (ressource « invisible »), ou page d'onboarding |

Règle d'or du diagnostic : **un 401 ne se corrige jamais en donnant des droits, un 403 ne se corrige jamais en se reconnectant.** Si tu hésites, c'est que tu n'as pas encore regardé le code.

Deux RBAC différents coexistent, ne les mélange pas :

- **RBAC Kubernetes** (étape 6) : ce que *toi* ou *un pod* peut faire sur l'API du cluster.
- **Autorisation applicative** : ce qu'*un utilisateur de la plateforme* peut faire sur *une conversation, une bibliothèque, un modèle*. Rien à voir avec le cluster.

---

## 13.2 Deux chemins : humain et machine

Rappel de l'étape 11 : ils ne traversent pas les mêmes composants.

```
HUMAIN (navigateur)                          MACHINE (script, application)
 │                                            │
 ├─ redirection vers l'IdP                    ├─ en-tête Authorization: Bearer <clé>
 ├─ login (mot de passe, SSO client, MFA)     │
 ├─ retour avec un code                       │
 ├─ backend échange le code → jetons          ├─ backend vérifie la clé (hash en base / cache)
 ├─ session (cookie)                          ├─ clé → organisation, projet, scopes
 ▼                                            ▼
 identité + organisation ─────────────▶ autorisation fine ─────▶ action
```

| | Humain | Machine |
|---|---|---|
| Preuve d'identité | Session issue d'un login OIDC | Clé API (ou jeton OAuth client credentials) |
| Dépend de l'IdP à chaque requête ? | Non (session), mais à chaque login / refresh | **Non** |
| Durée de vie | Session courte + refresh | Longue, jusqu'à révocation ou expiration |
| Rattachement | Via l'appartenance de l'utilisateur à une organisation | Directement à une organisation / un projet |
| Révocation | Déconnexion, désactivation dans l'IdP (effet différé : la session survit) | Suppression de la clé (effet immédiat si pas de cache long) |

Conséquence diagnostique à retenir : **login humain cassé + API par clé fonctionnelle = le problème est dans le chemin OIDC** (IdP, callback, cookie, CA, horloge), pas dans le backend ni la base.

---

## 13.3 OIDC en clair

**OAuth 2.0** définit comment une application obtient un jeton pour agir. **OIDC** (OpenID Connect) ajoute par-dessus *l'identité* : un **ID token** qui dit qui est l'utilisateur.

### Les acteurs

| Rôle | Chez nous |
|---|---|
| **Utilisateur** | L'humain dans son navigateur |
| **Client** (Relying Party) | Le backend/frontend de la plateforme, identifié par un `client_id` (et un `client_secret` s'il est confidentiel) |
| **IdP** (OpenID Provider) | L'IdP de la plateforme (type Keycloak), qui peut lui-même déléguer à l'IdP du client (13.5) |

### Les jetons

| Jeton | Pour qui | Contient | Durée typique |
|---|---|---|---|
| **ID token** (JWT) | Le client, pour savoir *qui* | `sub`, `email`, `iss`, `aud`, `exp`, `nonce` | Minutes |
| **Access token** (souvent JWT) | Les APIs, pour savoir *quoi* autoriser | `sub`, `scope`, rôles, `aud`, `exp` | Minutes |
| **Refresh token** | Le client, pour obtenir de nouveaux jetons | Opaque | Heures à jours |

Un JWT se décode (base64), il ne se déchiffre pas. **Décoder n'est pas vérifier** : la vérification = signature valide avec les clés publiques de l'IdP (JWKS) + `iss` attendu + `aud` attendu + `exp` non dépassé.

### Le discovery document

Tout commence par :

```bash
curl -s https://auth.client.com/realms/platform/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint, jwks_uri}'
```

L'`issuer` qu'il renvoie doit être **exactement** celui que le backend attend (schéma, host, chemin, slash final). Une différence d'un caractère = tous les jetons rejetés.

### Authorization code + PKCE, pas à pas

```
1. Navigateur → /login de la plateforme
2. Le client génère :
     state          (anti-CSRF, lié à la session du navigateur)
     nonce          (lié à l'ID token)
     code_verifier  (secret aléatoire) et code_challenge = SHA256(code_verifier)
3. Redirection → IdP /authorize?client_id=…&redirect_uri=…&scope=openid…&state=…&code_challenge=…
4. L'utilisateur s'authentifie chez l'IdP (qui a sa propre session / cookie)
5. IdP → redirection vers redirect_uri?code=XYZ&state=…
6. Le client vérifie state, puis appelle (serveur à serveur) IdP /token avec code + code_verifier
7. IdP vérifie SHA256(code_verifier) == code_challenge, renvoie ID/access/refresh tokens
8. Le client vérifie l'ID token (signature via JWKS, iss, aud, exp, nonce)
9. Le client crée SA session (cookie) et redirige vers l'application
```

Ce que protège chaque élément :

- **`code` et non jeton dans l'URL** : le jeton ne transite jamais par le navigateur ni l'historique.
- **PKCE** : un code intercepté est inutile sans le `code_verifier`. Obligatoire pour les clients publics (SPA, mobile), recommandé partout.
- **`state`** : empêche un attaquant de te faire atterrir dans *sa* session.
- **`nonce`** : empêche le rejeu d'un ID token.

### Les deux appels réseau que tout le monde oublie

Les étapes 6 et 8 sont des appels **du pod vers l'IdP**, pas du navigateur. Ils passent donc par :

- le **DNS** vu du pod (le host public de l'IdP résout-il depuis le cluster ?) ;
- l'**egress / proxy** (étape 12) ;
- la **CA** : si l'IdP a un certificat d'une CA d'entreprise, le pod doit la connaître → `x509: certificate signed by unknown authority` dans les logs du backend, alors que le navigateur, lui, affiche l'IdP sans souci.

Symptôme type : login OK chez l'IdP, puis retour sur la plateforme avec une erreur générique ou une boucle. **Le navigateur a fait sa part, le pod n'a pas pu faire la sienne.**

### Sessions

Deux sessions superposées, à ne pas confondre :

- **Session IdP** (cookie sur le domaine de l'IdP) : « je t'ai déjà authentifié » → SSO silencieux.
- **Session applicative** (cookie sur le domaine de la plateforme, souvent adossée au cache KV, étape 17).

Conséquences :

- **Déconnexion de la plateforme ≠ déconnexion de l'IdP** : l'utilisateur clique « se connecter » et rentre sans mot de passe. Normal, sauf si le client exige un logout global (RP-initiated logout).
- **Cache KV vidé** = toutes les sessions applicatives perdues = tout le monde est renvoyé au login (et reconnecté silencieusement si la session IdP vit encore).
- **Désactiver un utilisateur dans l'IdP** n'éjecte pas une session existante avant son expiration ou le prochain refresh.
- **Cookies** : `Secure` exige que l'app sache qu'elle est en HTTPS (`X-Forwarded-Proto`, étape 12) ; `SameSite=Lax/Strict` et un IdP sur un domaine tiers peuvent casser le retour du callback dans certains navigateurs.

---

## 13.4 Realms, tenants et le piège des deux realms

Un **realm** (vocabulaire Keycloak ; « tenant » ailleurs) est un espace d'identité isolé : ses utilisateurs, ses clients OIDC, ses clés de signature, ses fournisseurs d'identité, son `issuer`.

Configuration fréquente d'une plateforme :

| Realm | Usage |
|---|---|
| `master` | Administration de l'IdP lui-même. **Jamais** d'utilisateurs finaux. |
| Realm de la plateforme | Utilisateurs finaux, clients OIDC des composants, brokering vers l'IdP du client |

### Le piège des deux realms

Un utilisateur existe (ou est créé, ou le brokering est configuré) dans le **realm A**, mais un composant vérifie les jetons contre le **realm B**. Variantes :

- l'admin configure le fournisseur SAML du client dans `master` au lieu du realm plateforme ;
- un composant a son `issuer` pointé sur un ancien realm (renommé, ou realm de démo) ;
- deux environnements partagent un IdP, et une value copiée d'un autre environnement pointe sur le realm voisin.

Symptômes, tous trompeurs :

- login réussi chez l'IdP (« le mot de passe marche ! »), puis 401 sur la plateforme ;
- `invalid issuer` / `signature verification failed` dans les logs du backend (les clés de signature diffèrent par realm) ;
- utilisateur « introuvable » alors qu'il est bien visible… dans l'autre realm de la console.

Réflexe : pour chaque composant qui vérifie des jetons, relever **l'issuer attendu** (values / env) et le comparer au `iss` **d'un vrai jeton** :

```bash
helm get values platform -n platform -a | grep -iE 'issuer|realm|oidc' 
# décoder le payload d'un jeton (sans l'afficher en entier dans un partage d'écran)
cut -d. -f2 < token.txt | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{iss, aud, azp, exp, sub}'
```

---

## 13.5 Identity brokering vers l'IdP du client

Un client n'a jamais envie de créer ses utilisateurs dans *ton* IdP. Il veut que ses employés se connectent avec **son** SSO (Entra ID / Azure AD, Okta, ADFS, Google Workspace, Ping…).

L'IdP de la plateforme joue alors **intermédiaire** (broker) :

```
Navigateur → plateforme → IdP plateforme (realm) → IdP du client (OIDC ou SAML)
                                ▲                         │
                                └──── assertion/jetons ───┘
                          crée/met à jour l'utilisateur fédéré,
                          émet SES propres jetons vers la plateforme
```

Intérêt : la plateforme ne parle **qu'à un seul IdP**, quel que soit le client ; seul le broker change.

### OIDC vs SAML côté client

| | OIDC | SAML 2.0 |
|---|---|---|
| Format | JSON / JWT | XML signé |
| Config à échanger | `issuer` (discovery), `client_id`, `client_secret`, redirect URI | Metadata XML dans les deux sens (entity ID, ACS URL, certificat de signature) |
| Fréquent chez | Entreprises récentes, Google, Okta | Grands comptes, ADFS, historique |
| Pièges | Scopes/claims absents (`email` non renvoyé) | Certificat de signature qui expire/tourne, `NameID` au mauvais format, horloges décalées |

### Ce qu'il faut obtenir du client (checklist)

- Protocole et metadata / discovery URL.
- **Redirect URI / ACS URL** que *tu* leur donnes, exacte (host public, chemin du broker, realm) — une faute = erreur `redirect_uri mismatch` chez eux.
- **Attributs / claims** transmis : identifiant stable (`sub` / `NameID` persistant — **pas l'email**, qui change), email, nom, **groupes**.
- **Qui a le droit** : tous les employés, ou un groupe ? Filtrer chez eux (assignation de l'application) plutôt que chez toi.
- **Joignabilité** : l'IdP du client est-il accessible depuis le cluster (OIDC fait des appels serveur à serveur) ? Via quel proxy ? Quelle CA ?
- **Certificat de signature SAML** : date d'expiration et procédure de rotation.
- Contact technique chez eux **avec les droits de modifier l'application SSO** (sinon chaque itération prend une semaine).

### Mapping et provisioning

- **Just-in-time** : l'utilisateur est créé dans le realm à sa première connexion. Simple ; mais un utilisateur supprimé chez le client n'est pas supprimé chez toi (il ne peut juste plus se connecter).
- **SCIM** / synchronisation : l'IdP client pousse les créations/suppressions. Plus propre, plus de configuration.
- **Mappers** : attribut du client → attribut / rôle / groupe dans le realm → claim dans les jetons de la plateforme. Chaque maillon peut perdre la donnée : c'est la cause classique du « l'utilisateur se connecte mais n'est dans aucune organisation ».
- **Liaison de comptes** : un utilisateur local et un utilisateur fédéré avec le même email. Laisser l'IdP lier automatiquement par email est une faille si l'IdP amont ne garantit pas la vérification des emails.

### Comptes locaux = artefact de démo

Sur une démo ou une preview, on crée des utilisateurs directement dans le realm (mot de passe local). C'est pratique, et c'est **à ne pas laisser en production** :

- ils contournent le SSO, la MFA, le cycle de départ des employés du client ;
- ils survivent à la personne (compte `admin@demo`, `test1`) ;
- un auditeur les trouvera.

En production : brokering uniquement, formulaire de login local désactivé ou réservé à un **compte d'urgence** documenté, au mot de passe dans le coffre du client. Et quand tu montres une démo à un client, dis-le : « ici, comptes locaux de démo ; chez vous, ce sera votre SSO ».

---

## 13.6 Clés API : le chemin machine

### Cycle de vie

```
création (par un humain authentifié, dans une organisation/projet)
 → affichage UNE fois → stockage côté serveur en hash
 → usage (Bearer) → dernière utilisation enregistrée
 → rotation (nouvelle clé, période de recouvrement, révocation de l'ancienne)
 → révocation / expiration
```

Principes :

- **La clé appartient à une organisation (ou un projet), pas à la personne qui l'a créée.** Sinon le départ d'un employé casse la production du client — ou pire, sa clé continue de fonctionner indéfiniment « au nom » de quelqu'un parti.
- **Stockée hachée** : personne, pas même l'admin, ne peut la relire. Perdue = on en recrée une.
- **Préfixe identifiable** (`plt_…`) : permet le scanning de secrets dans les dépôts et une révocation rapide.
- **Scopes / périmètre** : quels modèles, quelles APIs, quel projet.
- **Quotas et consommation** rattachés à l'organisation (étape 14).
- **Cache de validation** : si les clés valides sont mises en cache (cache KV), une révocation met jusqu'au TTL du cache à prendre effet. À savoir, et à dire au client.

### Hygiène (rappel étape 6, appliqué)

- Une clé ne s'écrit **jamais en argument de commande** (`curl -H "Authorization: Bearer plt_…"` finit dans l'historique et dans le transcript d'un agent). Utilise une variable lue sans écho ou un fichier :
  ```bash
  read -rs PLT_KEY && export PLT_KEY     # saisie sans écho
  curl -s -H @<(printf 'Authorization: Bearer %s\n' "$PLT_KEY") https://api.client.com/v1/models
  ```
- Une clé montrée en partage d'écran = une clé à révoquer.
- En test, une clé **dédiée, à courte durée, dans une organisation de test**.

---

## 13.7 Autorisation : rôles IdP vs permissions fines (ReBAC)

### Rôles (RBAC applicatif)

Des rôles grossiers portés par l'identité : `platform-admin`, `org-admin`, `member`. Ils arrivent souvent **dans le jeton** (claim `roles` / `groups`) depuis l'IdP, parfois depuis les groupes du client via le brokering.

Bien pour : « peut accéder à la console d'admin », « peut gérer les membres de l'organisation ».

Limites :

- impossible d'exprimer « Alice peut lire *cette* bibliothèque partagée par Bob » avec des rôles ;
- un rôle dans un jeton **ne change qu'au prochain login/refresh** ;
- jetons gonflés si l'utilisateur a des centaines de groupes (en-têtes trop gros → **431** ou **400** du controller, étape 12).

### ReBAC (Relationship-Based Access Control, modèle Zanzibar)

Modèle issu du système d'autorisation interne de Google. On ne stocke pas des rôles mais des **relations** (tuples) :

```
library:finance#owner@user:bob
library:finance#viewer@group:finance-team#member
group:finance-team#member@user:alice
organization:acme#admin@user:carol
library:finance#parent@organization:acme
```

Et un **schéma** qui dit comment les relations se combinent :

```
definition library {
  relation owner:  user
  relation viewer: user | group#member
  relation parent: organization
  permission read  = viewer + owner + parent->admin
  permission write = owner + parent->admin
}
```

Question posée par l'application : `check(library:finance, read, user:alice)` → **oui**, via `finance-team`.

Ce que ça change pour toi, opérationnellement :

- C'est **un composant de plus** du plan d'identité, avec **sa propre base** (plan de données). S'il est lent, *toutes* les requêtes le sont ; s'il est en panne, soit tout est 403 (fail-closed, sain), soit tout est permis (fail-open, grave — à vérifier dans la config).
- **Cohérence** : une permission accordée peut mettre un court instant à être visible. « J'ai partagé, il ne voit pas » immédiatement après = parfois normal.
- **Diagnostic d'un 403 fin** : le rôle IdP est bon, le jeton est valide, mais la relation manque. Les outils du moteur (check, expand, lookup) répondent à « pourquoi Alice n'a-t-elle pas accès ? » bien mieux que les logs applicatifs.
- **Les relations se peuplent** : à la création d'une organisation, d'une bibliothèque, à l'ajout d'un membre, à la synchronisation des groupes du client. Une migration ou un import de données qui oublie les tuples produit des ressources **existantes en base mais invisibles** (404 ou liste vide plutôt que 403).

### Qui décide quoi

| Question | Où regarder |
|---|---|
| L'utilisateur est-il authentifié ? | Jeton / session, logs du backend et de l'IdP |
| Est-il admin de la plateforme / d'une organisation ? | Rôles dans l'IdP → claim dans le jeton |
| Est-il membre de la bonne organisation ? | Mapping brokering, table d'appartenance, ReBAC |
| Peut-il lire *cette* ressource ? | Moteur ReBAC (check) |

---

## 13.8 Diagnostiquer sans navigateur

Le navigateur cache tout : redirections, cookies, erreurs dans un onglet réseau qu'on ne peut pas partager. Chez un client, depuis un bastion, tu dois pouvoir tout objectiver en ligne de commande.

### 1. L'IdP répond-il, et avec quel issuer ?

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://auth.client.com/realms/platform/.well-known/openid-configuration
curl -s https://auth.client.com/realms/platform/.well-known/openid-configuration | jq -r .issuer
```

Et **depuis un pod** du backend (DNS, proxy, CA vus du cluster) :

```bash
kubectl exec -n platform deploy/api -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" "$OIDC_ISSUER/.well-known/openid-configuration"'
```

`000` + erreur `x509` ou timeout ici, alors que ça marche depuis ton poste = CA ou egress (13.3).

### 2. Obtenir un jeton sans navigateur : password grant

Le flux **Resource Owner Password Credentials** (`grant_type=password`) échange directement identifiant + mot de passe contre des jetons. Il est **déprécié** pour les applications et doit rester désactivé en production, mais c'est un excellent outil de diagnostic **sur un client OIDC de test prévu pour ça, avec un compte de test local** :

```bash
read -rs TEST_PW
curl -s https://auth.client.com/realms/platform/protocol/openid-connect/token \
  -d grant_type=password -d client_id=diag-cli -d username=diag-user \
  --data-urlencode "password=$TEST_PW" -d scope=openid \
  | jq -r .access_token > /tmp/token && chmod 600 /tmp/token
unset TEST_PW
```

Il ne marche pas avec un utilisateur fédéré (le mot de passe est chez le client) : pour ceux-là, on s'appuie sur les logs (point 4).

### 3. Le code HTTP comme verdict

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.client.com/v1/me                                   # sans jeton → 401 attendu
curl -s -o /dev/null -w '%{http_code}\n' -H @<(printf 'Authorization: Bearer %s\n' "$(cat /tmp/token)") https://api.client.com/v1/me        # → 200 ?
curl -s -o /dev/null -w '%{http_code}\n' -H @<(printf 'Authorization: Bearer %s\n' "$(cat /tmp/token)") https://api.client.com/v1/admin/orgs # → 403 si non admin
```

| Résultat | Lecture |
|---|---|
| 401 avec jeton frais | Jeton rejeté : issuer, audience, signature (realm), horloge |
| 200 sur `/me`, 403 sur la ressource | Authentifié, pas autorisé : rôle ou relation |
| 200 sur `/me` mais pas d'organisation dans la réponse | Rattachement / mapping |
| 302 vers l'IdP au lieu de 401 | Tu tapes une route « navigateur » (session), pas une route API |

Regarde aussi l'en-tête **`WWW-Authenticate`** d'un 401 : il contient souvent la raison (`error="invalid_token", error_description="…expired"`).

### 4. Les marqueurs côté serveur

Les **événements de l'IdP** (Keycloak : événements de login à activer dans le realm) sont la source de vérité. Messages à reconnaître :

| Marqueur | Sens |
|---|---|
| `user_not_found` | Identifiant inconnu **dans ce realm** → piège des deux realms, faute de frappe, utilisateur fédéré jamais créé |
| `invalid_user_credentials` | Mauvais mot de passe (local) |
| `invalid_redirect_uri` | `redirect_uri` non déclarée dans le client OIDC |
| `invalid_client_credentials` | `client_secret` faux → Secret Kubernetes désynchronisé de l'IdP |
| `expired_code` / `invalid_code` | Code réutilisé ou échangé trop tard (onglet périmé, rejeu, retry automatique) |
| `identity_provider_error` / erreur de broker | Problème côté IdP du client : assertion SAML invalide, certificat, attribut manquant |
| `invalid_grant` + `Session not active` | Refresh token dont la session IdP a expiré |
| `clock skew` / `token is not active yet` | Horloges désynchronisées (nœud, IdP, IdP client) |

**Corrélation par session.** Un login implique au moins le navigateur, le controller, l'IdP, parfois l'IdP client, puis le backend. Pour relier les morceaux :

- récupère **l'heure exacte** et, si possible, **l'identifiant de session ou de requête** (événement IdP : `sessionId`, `userId`, `ipAddress` ; backend : request ID, trace ID) ;
- filtre les logs de chaque composant sur cette fenêtre et cet identifiant, dans l'ordre du flux ;
- **vérifie l'heure** : UTC vs heure locale, décalage entre nœuds. Beaucoup de « rien dans les logs » sont des recherches sur la mauvaise heure.

```bash
kubectl logs -n platform deploy/idp --since=15m | grep -E 'type=(LOGIN|CODE_TO_TOKEN)_ERROR|error=' 
kubectl logs -n platform deploy/api --since=15m | grep -iE 'jwt|token|issuer|audience|401|403'
```

Ne jamais afficher de jeton complet ni de cookie de session dans ces sorties : filtre, tronque.

### 5. L'onglet de login périmé

Cas vécu et récurrent : l'utilisateur (ou toi) a laissé un onglet sur la page de login de l'IdP pendant des heures, ou a redéployé l'IdP/la plateforme entre-temps. Il saisit ses identifiants et obtient une erreur (« page expirée », « session invalide », boucle de redirection, `invalid state` / `expired_code` dans les logs).

Rien n'est cassé : le `state`, le code ou la session d'authentification de cet onglet ne correspondent plus à rien.

Réflexe : **avant tout diagnostic d'un login en échec, recommencer depuis l'URL de la plateforme dans une fenêtre privée neuve**. Si ça marche, noter « faux positif : onglet périmé » et passer à autre chose.

---

## 13.9 Pièges

- **Confondre 401 et 403**, et donner des droits pour résoudre un problème d'authentification.
- **Tester depuis ton poste seulement** : l'échange de code et le JWKS se font depuis le pod (DNS, proxy, CA).
- **Issuer au caractère près** (slash final, `http` vs `https`, host interne vs public).
- **Deux realms** : utilisateur ou fournisseur configuré dans l'un, vérification contre l'autre ; utilisateurs finaux dans `master`.
- **`client_secret` régénéré dans l'IdP** sans mettre à jour le Secret Kubernetes (ou l'inverse, après une réinstallation de l'IdP).
- **Redirect URI** avec un autre host (interne vs public), un port, un slash.
- **Horloges** : quelques minutes de décalage suffisent à invalider des jetons ou des assertions SAML.
- **Email comme identifiant stable** du brokering.
- **Mapping de groupes perdu** : l'utilisateur se connecte mais n'appartient à aucune organisation.
- **Liaison automatique de comptes par email** sur un IdP amont non fiable.
- **Comptes locaux de démo** laissés en production.
- **Clé API rattachée à une personne** plutôt qu'à l'organisation ; clé en argument de commande.
- **Révocation non immédiate** à cause d'un cache, non annoncée au client.
- **Rôle changé dans l'IdP, invisible** jusqu'au prochain login / refresh.
- **Moteur ReBAC en fail-open** ; tuples non migrés → ressources invisibles.
- **Jeton trop gros** (trop de groupes) → 431/400 du controller.
- **Password grant laissé actif** en production « pour le diagnostic ».
- **Onglet de login périmé** pris pour une panne.
- **Cache KV vidé** → déconnexion générale prise pour une panne d'IdP.

---

## 13.10 Exercice — provoquer un 401 et un 403, les distinguer dans les logs

Sur ton cluster kind (réutilise l'ingress et cert-manager de l'étape 12).

### Partie 1 — Mettre en place

1. Déploie un IdP (Keycloak via un chart) avec la base dédiée qu'il demande. Expose-le sur `auth.lab.local`.
2. Crée un realm `lab`, **active les événements de login** (et les événements d'admin).
3. Crée deux clients OIDC :
   - `app` : confidentiel, authorization code + PKCE, redirect URI `https://app.lab.local/*` ;
   - `diag-cli` : réservé au diagnostic, **password grant autorisé** (à noter comme tel).
4. Crée deux utilisateurs locaux (artefacts de démo, assumés) : `alice` avec le rôle `admin`, `bob` sans rôle.
5. Place devant ton app de l'étape 7 un **proxy d'authentification** (type oauth2-proxy) ou une petite API qui vérifie les JWT (issuer, audience, signature via JWKS) et expose :
   - `GET /me` → authentifié ;
   - `GET /admin` → exige le rôle `admin`.
6. Monte la CA auto-signée de l'étape 12 dans ce pod. Vérifie que le discovery répond **depuis le pod**.

### Partie 2 — Le parcours nominal, sans navigateur

1. Récupère un jeton pour `alice` et un pour `bob` via password grant, dans des fichiers `600`, sans afficher les mots de passe ni les jetons.
2. Décode les payloads (`iss`, `aud`, `exp`, rôles) sans afficher la signature.
3. Remplis ce tableau avec les codes obtenus :

| Appel | Sans jeton | bob | alice |
|---|---|---|---|
| `/me` | | | |
| `/admin` | | | |

### Partie 3 — Provoquer et lire

Pour chaque cas : code HTTP, en-tête `WWW-Authenticate` s'il existe, **ligne de log du proxy/API**, **événement de l'IdP** s'il y en a un. Tout noter.

| # | Provocation | Attendu |
|---|---|---|
| 1 | Pas de jeton | 401 |
| 2 | Jeton de `bob` sur `/admin` | 403 |
| 3 | Jeton expiré (attends son `exp`, ou réduis la durée de vie à 1 min) | 401, `expired` |
| 4 | Jeton modifié d'un caractère dans la signature | 401, signature |
| 5 | Crée un realm `lab2`, un utilisateur `alice` dedans, obtiens un jeton, appelle l'API configurée sur `lab` | 401, issuer / signature — **le piège des deux realms** |
| 6 | Password grant sur `lab` avec un utilisateur qui n'existe que dans `lab2` | Événement `user_not_found` |
| 7 | `client_secret` de `app` régénéré dans l'IdP, Secret Kubernetes inchangé | Échec d'échange de code, `invalid_client_credentials` |
| 8 | Retire la CA montée dans le pod, redémarre | Erreur `x509` au chargement du JWKS, puis 401 (ou 500) sur tout |
| 9 | Retire le rôle `admin` à `alice` dans l'IdP **sans** renouveler son jeton, appelle `/admin` | 200 encore → le rôle vit dans le jeton jusqu'à expiration |

### Partie 4 — Corréler

Refais le cas 2 et le cas 5 en notant l'heure à la seconde. Retrouve **dans les logs des deux composants** (IdP et API) les lignes correspondantes, et écris la chaîne des événements dans l'ordre. Vérifie au passage dans quel fuseau horaire logue chaque composant.

### Partie 5 — Sur l'environnement de preview (lecture seule)

1. Relève pour chaque composant qui vérifie des jetons : issuer attendu, audience, realm.
2. Liste les realms, les clients OIDC, les fournisseurs d'identité configurés, et **les comptes locaux** existants.
3. Identifie : le moteur d'autorisation fine (s'il y en a un), sa base, son comportement en panne (fail-open / fail-closed — dans la config ou la doc, sinon marquer « à vérifier »).
4. Rattachement : comment un utilisateur fédéré arrive-t-il dans une organisation ?
5. Clés API : où sont-elles stockées, à quoi sont-elles rattachées, y a-t-il un cache de validation et quel TTL ?

**Livrable** : section « Plan d'identité » de `carte-plateforme-<version>.md` : realms et leur rôle, clients OIDC, brokering prévu, rattachement aux organisations, clés API, moteur d'autorisation, marqueurs de log utiles, et la **checklist SSO client** de 13.5 prête à envoyer.

---

## Validé si…

Tu peux expliquer à voix haute :

- la différence entre 401 et 403, et pourquoi on ne corrige jamais l'un avec le remède de l'autre ;
- pourquoi « le login humain échoue mais l'API par clé marche » localise le problème ;
- les étapes d'authorization code + PKCE, et ce que protègent `state`, `nonce` et PKCE ;
- les deux appels du flux OIDC qui partent du pod, et les trois choses qui peuvent les faire échouer ;
- le piège des deux realms, ses symptômes, et la comparaison qui le révèle ;
- ce qu'est l'identity brokering, et cinq éléments à obtenir d'un client pour le brancher ;
- pourquoi les comptes locaux sont un artefact de démo ;
- à quoi est rattachée une clé API, et pourquoi sa révocation peut ne pas être immédiate ;
- ce que le ReBAC exprime et que des rôles ne peuvent pas, et ce que ça ajoute comme composant et comme risque ;
- comment obtenir un jeton et objectiver un problème sans navigateur, et pourquoi le password grant reste un outil de test ;
- trois marqueurs d'événements IdP et leur sens ;
- quoi faire en premier face à un login en échec (fenêtre privée neuve — l'onglet périmé).

**Étape suivante** : `etape-14-gouvernance-usage.md` — gouvernance de l'usage.
