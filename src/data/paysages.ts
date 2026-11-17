// Un paysage par partie du cours (DA « pixel chill », docs/da-pixel.md).
// A : le socle, solide comme la montagne. B : Helm, la barre du voilier. C : la plateforme qui pousse.
// D : le diagnostic, sous la pluie. E : la restitution, à l'aube. F : les cas pratiques, en forêt.
// L'accueil a sa propre scène le jour (grand large, src/scripts/paysages.ts), pour ne pas doubler la partie A.
import type { Partie } from './etapes';
import type { NomScene } from '../scripts/pixel/scenes';

export const paysageDePartie: Record<Partie['id'], NomScene> = {
  A: 'montagne',
  B: 'mer',
  C: 'prairie',
  D: 'pluie',
  E: 'aube',
  F: 'foret',
};
