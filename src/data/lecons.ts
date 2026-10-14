import { getCollection, type CollectionEntry } from 'astro:content';
import { etapes, parties } from './etapes';

export type Lecon = CollectionEntry<'lecons'>;

export async function toutesLesLecons(): Promise<Lecon[]> {
  const all = await getCollection('lecons');
  return all.sort((a, b) => a.data.etape - b.data.etape || a.data.ordre - b.data.ordre);
}

export const urlLecon = (l: Lecon) => `/l/${l.id}/`;

/** Parcours mobile = leçons uniquement ; les labs sont à part, optionnels. */
export const estLecon = (l: Lecon) => l.data.type === 'lecon';

export async function parcours() {
  const lecons = await toutesLesLecons();
  return parties.map((p) => ({
    ...p,
    etapes: etapes
      .filter((e) => e.partie === p.id)
      .map((e) => ({ ...e, lecons: lecons.filter((l) => l.data.etape === e.n) })),
  }));
}

/** Données de quiz sérialisables pour le client (contrôles, révisions). */
export function questionsDe(l: Lecon) {
  return l.data.quiz.map((q, i) => ({
    id: `${l.id}#${i}`,
    lecon: l.id,
    titre: l.data.titre,
    url: urlLecon(l),
    ...q,
  }));
}
