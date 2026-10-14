-- Base D1 de progression : une ligne par utilisateur, l'état complet en JSON.
CREATE TABLE IF NOT EXISTS progression (
  email TEXT PRIMARY KEY,
  data  TEXT NOT NULL,
  maj   INTEGER NOT NULL
);
