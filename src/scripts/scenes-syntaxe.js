// Syntaxe des schémas animés, partagée par le site (scenes.ts) et le contrôle qualité (check-lecons.mjs).
//
// Dans un bloc ```mermaid, chaque ligne « %% scene: » décrit une étape du pas à pas :
//
//   %% scene: Titre court :: Une ou deux phrases d'explication :: A, B, A>B, !C
//
// Éléments, séparés par des virgules :
//   A      le nœud (ou le subgraph) A s'allume
//   !A     le nœud A s'allume en alerte (ambre : annulé, bloqué, perdu)
//   A>B    un jeton circule le long de la flèche entre A et B, dans ce sens
//          (la flèche peut être écrite B --> A dans le schéma : le jeton la remonte)
//   !A>B   idem, jeton en alerte
// Mermaid ignore ces lignes (commentaires %%).

/** @typedef {{ type: 'noeud', id: string, alerte: boolean } | { type: 'arete', de: string, vers: string, alerte: boolean }} Element */
/** @typedef {{ titre: string, texte: string, elements: Element[] }} Scene */

export const RE_SCENE = /^\s*%%\s*scene\s*:(.*)$/i;

/** @param {string} source @returns {Scene[]} */
export function lireScenes(source) {
  return source
    .split('\n')
    .map((l) => l.match(RE_SCENE))
    .filter((m) => m !== null)
    .map((m) => {
      const [titre = '', texte = '', elements = ''] = m[1].split('::').map((s) => s.trim());
      return {
        titre,
        texte,
        elements: elements.split(',').map((s) => s.trim()).filter(Boolean).map(lireElement),
      };
    });
}

/** @param {string} brut @returns {Element} */
function lireElement(brut) {
  const alerte = brut.startsWith('!');
  const s = alerte ? brut.slice(1).trim() : brut;
  const m = s.match(/^([\w-]+)\s*>\s*([\w-]+)$/);
  return m ? { type: 'arete', de: m[1], vers: m[2], alerte } : { type: 'noeud', id: s, alerte };
}
