// Rend les blocs ```mermaid des leçons en schémas, aux couleurs du site (clair/sombre).

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
    flowchart: { htmlLabels: true, curve: 'basis', padding: 10, nodeSpacing: 28, rankSpacing: 36 },
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
    } catch (e) {
      console.error('Schéma invalide', e);
      pre.classList.add('schema-erreur');
    }
  }
}
