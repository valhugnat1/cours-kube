CREATE TABLE IF NOT EXISTS progression (email TEXT PRIMARY KEY, data TEXT NOT NULL, maj INTEGER NOT NULL);
-- Précisions à la demande (créée aussi automatiquement par le Worker au premier appel).
CREATE TABLE IF NOT EXISTS precisions (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, lecon TEXT NOT NULL, bloc INTEGER NOT NULL DEFAULT 0,
  passage TEXT NOT NULL, contexte TEXT NOT NULL DEFAULT '', niveau TEXT NOT NULL, question TEXT NOT NULL DEFAULT '',
  precedente TEXT, statut TEXT NOT NULL, activite TEXT NOT NULL DEFAULT '', reponse TEXT NOT NULL DEFAULT '',
  erreur TEXT NOT NULL DEFAULT '', run_url TEXT NOT NULL DEFAULT '',
  cree INTEGER NOT NULL, maj INTEGER NOT NULL, demarree INTEGER, finie INTEGER);
CREATE INDEX IF NOT EXISTS precisions_lecon ON precisions (email, lecon);
