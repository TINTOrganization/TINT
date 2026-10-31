/// <reference types="node" />
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectorLinks, isInternalStep } from '../lib/archSim';
import { ARCH_CONNECTORS, ARCH_NODE_SIZE, ARCH_NODES, ARCH_VIEWBOX } from './architecture';
import { ARCH_STORIES } from './architectureStories';
import { quizQuestions } from './quizQuestions';

const REPO_ROOT = resolve(__dirname, '../../../..');
const exists = (src: string) => existsSync(resolve(REPO_ROOT, src.split('#')[0]));
const nodeIds = new Set<string>(ARCH_NODES.map((n) => n.id));

describe('modelo de la arquitectura', () => {
  it('tiene los 10 componentes con ids únicos y dentro del lienzo', () => {
    expect(ARCH_NODES).toHaveLength(10);
    expect(nodeIds.size).toBe(10);
    for (const n of ARCH_NODES) {
      expect(n.x - ARCH_NODE_SIZE.width / 2, n.id).toBeGreaterThanOrEqual(0);
      expect(n.x + ARCH_NODE_SIZE.width / 2, n.id).toBeLessThanOrEqual(ARCH_VIEWBOX.width);
      expect(n.y - ARCH_NODE_SIZE.height / 2, n.id).toBeGreaterThanOrEqual(0);
      expect(n.y + ARCH_NODE_SIZE.height / 2, n.id).toBeLessThanOrEqual(ARCH_VIEWBOX.height);
      expect(n.role.trim(), n.id).not.toBe('');
    }
  });

  it('ningún par de componentes se solapa', () => {
    for (const a of ARCH_NODES) {
      for (const b of ARCH_NODES) {
        if (a.id >= b.id) continue;
        const apart = Math.abs(a.x - b.x) >= ARCH_NODE_SIZE.width || Math.abs(a.y - b.y) >= ARCH_NODE_SIZE.height;
        expect(apart, `${a.id} y ${b.id}`).toBe(true);
      }
    }
  });

  it('tiene los conectores C1 a C15 de docs/arquitectura.md y sus extremos existen', () => {
    expect(ARCH_CONNECTORS.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `C${i + 1}`));
    for (const c of ARCH_CONNECTORS) {
      expect(c.links.length, c.id).toBeGreaterThan(0);
      for (const [a, b] of c.links) {
        expect(nodeIds.has(a), `${c.id}: ${a}`).toBe(true);
        expect(nodeIds.has(b), `${c.id}: ${b}`).toBe(true);
        expect(a, c.id).not.toBe(b);
      }
    }
  });

  it('cada fuente citada existe en el repositorio', () => {
    for (const item of [...ARCH_NODES, ...ARCH_CONNECTORS]) {
      expect(item.sources.length, item.id).toBeGreaterThan(0);
      for (const src of item.sources) expect(exists(src), `${item.id}: ${src}`).toBe(true);
    }
  });
});

describe('historias de la arquitectura', () => {
  it('tiene las cinco historias con ids únicos', () => {
    expect(ARCH_STORIES).toHaveLength(5);
    expect(new Set(ARCH_STORIES.map((s) => s.id)).size).toBe(5);
  });

  it('cada paso usa un conector que une de verdad a sus dos componentes', () => {
    for (const story of ARCH_STORIES) {
      story.steps.forEach((step, i) => {
        const at = `${story.id} paso ${i + 1}`;
        expect(nodeIds.has(step.from), at).toBe(true);
        expect(nodeIds.has(step.to), at).toBe(true);
        expect(step.message.trim(), at).not.toBe('');
        expect(step.detail.trim(), at).not.toBe('');
        if (isInternalStep(step)) {
          expect(step.to, at).toBe(step.from);
          return;
        }
        expect(step.to, at).not.toBe(step.from);
        expect(step.ask.trim(), at).not.toBe('');
        const connector = ARCH_CONNECTORS.find((c) => c.id === step.connector);
        expect(connector, `${at}: ${step.connector}`).toBeDefined();
        expect(connectorLinks(connector!, step.from, step.to), `${at}: ${step.connector} no une ${step.from} y ${step.to}`).toBe(true);
      });
    }
  });

  it('cada historia empieza en la web y ningún paso sale de un componente que aún no participó', () => {
    for (const story of ARCH_STORIES) {
      expect(story.steps[0].from, story.id).toBe('web');
      const seen = new Set<string>(['web']);
      story.steps.forEach((step, i) => {
        expect(seen.has(step.from), `${story.id} paso ${i + 1}: ${step.from}`).toBe(true);
        seen.add(step.to);
      });
    }
  });

  it('la pregunta de Predecir no nombra al componente que hay que adivinar', () => {
    for (const story of ARCH_STORIES) {
      story.steps.forEach((step, i) => {
        if (isInternalStep(step)) return;
        const target = ARCH_NODES.find((n) => n.id === step.to)!;
        const name = target.label.replace(' (SPA)', '').toLowerCase();
        // "la web" describe quién pregunta en muchos pasos; solo se exige en los demás destinos.
        if (step.to === 'web') return;
        expect(step.ask.toLowerCase().includes(name), `${story.id} paso ${i + 1}: "${step.ask}" nombra a ${name}`).toBe(false);
      });
    }
  });

  it('las fuentes y las preguntas relacionadas existen', () => {
    const quizIds = new Set(quizQuestions.map((q) => q.id));
    for (const story of ARCH_STORIES) {
      expect(story.quizIds.length, story.id).toBeGreaterThan(0);
      expect(new Set(story.quizIds).size, story.id).toBe(story.quizIds.length);
      for (const id of story.quizIds) expect(quizIds.has(id), `${story.id}: ${id}`).toBe(true);
      story.steps.forEach((step, i) => {
        expect(step.sources.length, `${story.id} paso ${i + 1}`).toBeGreaterThan(0);
        for (const src of step.sources) expect(exists(src), `${story.id} paso ${i + 1}: ${src}`).toBe(true);
      });
    }
  });
});
