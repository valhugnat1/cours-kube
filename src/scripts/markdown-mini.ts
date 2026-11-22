// Petit rendu Markdown pour les précisions rédigées par le robot : paragraphes, listes, un tableau,
// **gras**, *italique*, `code`, et blocs de code (```mermaid devient un schéma via schemas.ts).
// Tout est échappé avant mise en forme : aucun HTML venu de la réponse n'arrive tel quel dans la page.

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const enLigne = (s: string) =>
  echapper(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(«])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

const cellules = (ligne: string) => ligne.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownEnHtml(md: string): string {
  const lignes = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lignes.length) {
    const l = lignes[i];
    const bloc = l.match(/^\s*```\s*([\w-]*)/);
    if (bloc) {
      const code: string[] = [];
      i++;
      while (i < lignes.length && !/^\s*```/.test(lignes[i])) code.push(lignes[i++]);
      i++;
      const langue = bloc[1] ? ` class="language-${echapper(bloc[1])}"` : '';
      out.push(`<pre><code${langue}>${echapper(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(l)) {
      const rangs: string[][] = [];
      while (i < lignes.length && /^\s*\|/.test(lignes[i])) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lignes[i])) rangs.push(cellules(lignes[i]));
        i++;
      }
      const [tete, ...corps] = rangs;
      out.push(`<table><thead><tr>${tete.map((c) => `<th>${enLigne(c)}</th>`).join('')}</tr></thead><tbody>${
        corps.map((r) => `<tr>${r.map((c) => `<td>${enLigne(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const puce = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (puce.test(l)) {
      const ordonnee = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < lignes.length && (puce.test(lignes[i]) || (/^\s{2,}\S/.test(lignes[i]) && items.length))) {
        if (puce.test(lignes[i])) items.push(lignes[i].replace(puce, ''));
        else items[items.length - 1] += ` ${lignes[i].trim()}`;
        i++;
      }
      const t = ordonnee ? 'ol' : 'ul';
      out.push(`<${t}>${items.map((x) => `<li>${enLigne(x)}</li>`).join('')}</${t}>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lignes.length && lignes[i].trim() && !/^\s*(```|\|)/.test(lignes[i]) && !puce.test(lignes[i])) {
      para.push(lignes[i++].replace(/^#+\s*/, ''));
    }
    out.push(`<p>${enLigne(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
