import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ARCH_CONNECTORS, ARCH_NODES } from '../../data/architecture';
import { ARCH_STORIES } from '../../data/architectureStories';
import ArchDiagram, { type ArchDiagramProps } from './ArchDiagram';
import RelatedQuiz from './RelatedQuiz';

const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return { ...actual, m: actual.motion, useReducedMotion: () => reduced.value };
});

const base: ArchDiagramProps = {
  nodes: ARCH_NODES,
  connectors: ARCH_CONNECTORS,
  step: null,
  origin: null,
  selected: null,
  guess: null,
  packetKey: 'k',
  nodeAction: 'Ver ficha de',
  onNodeClick: () => {},
};

describe('ArchDiagram', () => {
  afterEach(() => {
    reduced.value = false;
  });

  it('dibuja los 10 componentes y una arista por par, con el trazo de su tipo', () => {
    const { container } = render(<ArchDiagram {...base} />);
    expect(screen.getAllByRole('button')).toHaveLength(10);
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(18);
    expect(container.querySelector('[data-edge="sync|web"]')).toHaveAttribute('stroke-width', '4');
    expect(container.querySelector('[data-edge="identity|redis"]')).toHaveAttribute('stroke-dasharray', '7 6');
    expect(container.querySelector('[data-edge="identity|web"]')).not.toHaveAttribute('stroke-dasharray');
    expect(container.querySelector('[data-packet]')).not.toBeInTheDocument();
  });

  it('las aristas que pasarían por detrás de otro nodo se dibujan curvas', () => {
    const { container } = render(<ArchDiagram {...base} />);
    expect(container.querySelector('[data-edge="firebase|social"]')!.getAttribute('d')).toContain('Q');
    expect(container.querySelector('[data-edge="identity|web"]')!.getAttribute('d')).toContain('L');
  });

  it('marca en rojo el componente elegido por error y resalta el destino correcto', () => {
    const step = ARCH_STORIES[0].steps[0];
    const { container } = render(<ArchDiagram {...base} step={step} guess="redis" />);
    expect(container.querySelector('[data-node="redis"] rect')).toHaveAttribute('stroke', '#f87171');
    expect(container.querySelector('[data-node="firebase"] rect')).toHaveAttribute('stroke', '#FF6B1A');
    expect(container.querySelector('[data-node="web"] rect')).toHaveAttribute('stroke', '#FF8A3D');
  });

  it('resalta el origen mientras se predice y el componente con la ficha abierta', () => {
    const { container } = render(<ArchDiagram {...base} origin="identity" selected="minio" />);
    expect(container.querySelector('[data-node="identity"] rect')).toHaveAttribute('stroke', '#FF8A3D');
    expect(container.querySelector('[data-node="minio"] rect')).toHaveAttribute('stroke', '#DBDEE1');
  });

  it('con movimiento reducido el paquete aparece ya en el destino', () => {
    reduced.value = true;
    const step = ARCH_STORIES[0].steps[0];
    const { container } = render(<ArchDiagram {...base} step={step} />);
    const packet = container.querySelector('[data-packet="edge"]')!;
    const firebase = ARCH_NODES.find((n) => n.id === 'firebase')!;
    const web = ARCH_NODES.find((n) => n.id === 'web')!;
    const cx = Number(packet.getAttribute('cx'));
    expect(Math.abs(cx - firebase.x)).toBeLessThan(Math.abs(cx - web.x));
  });

  it('con movimiento reducido el paso interno también se marca', () => {
    reduced.value = true;
    const step = ARCH_STORIES[0].steps[2];
    const { container } = render(<ArchDiagram {...base} step={step} />);
    expect(container.querySelector('[data-packet="internal"]')).toBeInTheDocument();
  });

  it('un paso con un componente que no está en el diagrama no dibuja paquete', () => {
    const step = ARCH_STORIES[0].steps[0];
    const { container } = render(<ArchDiagram {...base} nodes={ARCH_NODES.filter((n) => n.id !== 'firebase')} connectors={[]} step={step} />);
    expect(container.querySelector('[data-packet]')).not.toBeInTheDocument();
  });
});

describe('RelatedQuiz', () => {
  it('no muestra nada si la historia no tiene preguntas conocidas', () => {
    const { container } = render(<RelatedQuiz quizIds={['no-existe']} />);
    expect(container).toBeEmptyDOMElement();
  });
});
