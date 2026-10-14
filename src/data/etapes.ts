// Le plan du cours : 5 parties, 25 étapes. Source de vérité pour le parcours.
// "dossier" = nom du dossier des leçons dans src/content/lecons/ et du fichier source dans sources/.

export type Partie = { id: 'A' | 'B' | 'C' | 'D' | 'E'; titre: string; resume: string };
export type Etape = { n: number; partie: Partie['id']; titre: string; dossier: string };

export const parties: Partie[] = [
  { id: 'A', titre: 'Socle Kubernetes', resume: 'Ce qu’il faut avoir en tête avant de toucher un chart.' },
  { id: 'B', titre: 'Helm et packaging', resume: 'Écrire, empiler et faire évoluer des charts parapluie.' },
  { id: 'C', titre: 'La plateforme LLM, plan par plan', resume: 'Entrée, identité, inférence, données, observabilité.' },
  { id: 'D', titre: 'Exploitation et diagnostic', resume: 'k9s, méthode de debug, environnements éphémères.' },
  { id: 'E', titre: 'Restitution client et pratique', resume: 'Répondre juste à un client, GitOps, certification.' },
];

export const etapes: Etape[] = [
  { n: 0, partie: 'A', titre: 'Environnement et prérequis', dossier: '00-environnement' },
  { n: 1, partie: 'A', titre: 'Architecture et modèle déclaratif', dossier: '01-architecture' },
  { n: 2, partie: 'A', titre: 'Contrôleurs, ownership, actions destructives', dossier: '02-controleurs' },
  { n: 3, partie: 'A', titre: 'Workloads avancés', dossier: '03-workloads' },
  { n: 4, partie: 'A', titre: 'Réseau Kubernetes', dossier: '04-reseau' },
  { n: 5, partie: 'A', titre: 'Stockage', dossier: '05-stockage' },
  { n: 6, partie: 'A', titre: 'Configuration, secrets et accès', dossier: '06-config-secrets' },
  { n: 7, partie: 'B', titre: 'Helm fondamentaux', dossier: '07-helm' },
  { n: 8, partie: 'B', titre: 'Chart parapluie et values', dossier: '08-parapluie' },
  { n: 9, partie: 'B', titre: 'CRDs, opérateurs et versions', dossier: '09-crds-operateurs' },
  { n: 10, partie: 'B', titre: 'Multi-environnement clients', dossier: '10-multi-env' },
  { n: 11, partie: 'C', titre: 'Architecture d’une plateforme LLM', dossier: '11-archi-plateforme' },
  { n: 12, partie: 'C', titre: 'Plan d’entrée', dossier: '12-plan-entree' },
  { n: 13, partie: 'C', titre: 'Identité, authentification, autorisation', dossier: '13-identite' },
  { n: 14, partie: 'C', titre: 'Gouvernance de l’usage', dossier: '14-gouvernance' },
  { n: 15, partie: 'C', titre: 'Inférence, routage et GPU', dossier: '15-inference-gpu' },
  { n: 16, partie: 'C', titre: 'Fonctionnalités produit', dossier: '16-produit' },
  { n: 17, partie: 'C', titre: 'Plan de données et continuité', dossier: '17-donnees' },
  { n: 18, partie: 'C', titre: 'Observabilité', dossier: '18-observabilite' },
  { n: 19, partie: 'D', titre: 'k9s et ses équivalents kubectl', dossier: '19-k9s' },
  { n: 20, partie: 'D', titre: 'Méthode de debug', dossier: '20-debug' },
  { n: 21, partie: 'D', titre: 'Environnements éphémères', dossier: '21-ephemeres' },
  { n: 22, partie: 'D', titre: 'Faux positifs récurrents', dossier: '22-faux-positifs' },
  { n: 23, partie: 'E', titre: 'Communication technique avec un client', dossier: '23-communication-client' },
  { n: 24, partie: 'E', titre: 'GitOps, opérations, certification', dossier: '24-gitops-certif' },
];

export const etapeParNumero = (n: number) => etapes.find((e) => e.n === n)!;
