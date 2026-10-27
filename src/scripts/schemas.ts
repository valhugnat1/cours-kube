// Rend les blocs ```mermaid des leçons en schémas, aux couleurs du site (clair/sombre).
// Un bloc qui contient des lignes « %% scene: » devient un schéma animé pas à pas (scenes.ts).

import { animer } from './scenes';
import { RE_SCENE } from './scenes-syntaxe.js';

export async function rendreSchemas() {
  const blocs = Array.from(document.querySelectorAll<HTMLElement>('code.language-mermaid'))
    .map((c) => c.closest('pre') as HTMLElement)
    .filter(Boolean);
  if (!blocs.length) return;

  const { default: mermaid } = await import('mermaid');
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const sombre = matchMedia('(prefers-color-scheme: dark)').matches;

  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    fontFamily: "'Literata Variable', Georgia, serif",
    flowchart: { htmlLabels: true, curve: 'basis', padding: 10, nodeSpacing: 28, rankSpacing: 36, subGraphTitleMargin: { top: 4, bottom: 10 } },
    sequence: { mirrorActors: false },
    themeVariables: {
      darkMode: sombre,
      fontSize: '16px',
      background: v('--papier'),
      primaryColor: v('--surface'),
      primaryBorderColor: v('--pin'),
      primaryTextColor: v('--encre'),
      secondaryColor: v('--pin-clair'),
      secondaryBorderColor: v('--pin'),
      tertiaryColor: v('--ambre-clair'),
      tertiaryBorderColor: v('--ambre'),
      lineColor: v('--encre-douce'),
      textColor: v('--encre'),
      clusterBkg: v('--papier'),
      clusterBorder: v('--trait'),
      edgeLabelBackground: v('--papier'),
      noteBkgColor: v('--ambre-clair'),
      noteBorderColor: v('--ambre'),
      noteTextColor: v('--encre'),
      actorBkg: v('--surface'),
      actorBorder: v('--pin'),
      signalColor: v('--encre'),
    },
  });

  for (const [i, pre] of blocs.entries()) {
    const source = pre.textContent ?? '';
    const div = document.createElement('figure');
    div.className = 'schema';
    try {
      const { svg } = await mermaid.render(`schema-${i}`, source);
      div.innerHTML = svg;
      pre.replaceWith(div);
      if (source.split('\n').some((l) => RE_SCENE.test(l))) animer(div, source);
    } catch (e) {
      console.error('Schéma invalide', e);
      pre.classList.add('schema-erreur');
    }
  }
}
