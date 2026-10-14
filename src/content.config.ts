import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Une leçon = un fichier MDX dans src/content/lecons/<NN-etape>/<NN-slug>.mdx
// L'id d'une leçon est son chemin sans extension : "01-architecture/02-boucle-reconciliation".
const lecons = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/lecons' }),
  schema: z.object({
    titre: z.string().min(3).max(80),
    etape: z.number().int().min(0).max(24),
    ordre: z.number().int().min(1),
    type: z.enum(['lecon', 'lab']).default('lecon'),
    duree: z.number().int().min(2).max(15).default(5),
    // Une phrase : ce que tu sais faire/expliquer après la leçon.
    objectif: z.string().min(10).max(160),
    // Commandes utiles : à connaître, pas à taper maintenant. 0 à 5 par leçon.
    commandes: z
      .array(z.object({ c: z.string().min(2), d: z.string().min(3).max(120) }))
      .max(5)
      .default([]),
    // 3 ou 4 questions. "bonne" est l'index (0-based) du bon choix.
    quiz: z
      .array(
        z.object({
          q: z.string().min(5),
          choix: z.array(z.string().min(1)).min(2).max(4),
          bonne: z.number().int().min(0).max(3),
          explication: z.string().min(5),
        }),
      )
      .max(4)
      .default([]),
  }),
});

export const collections = { lecons };
