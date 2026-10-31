import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ARCH_NODES, type ArchNodeId } from '../data/architecture';
import { ARCH_STORIES } from '../data/architectureStories';
import { quizQuestions } from '../data/quizQuestions';
import { isInternalStep } from '../lib/archSim';
import Arquitectura from './Arquitectura';

const login = ARCH_STORIES[0];
const label = (id: ArchNodeId) => ARCH_NODES.find((n) => n.id === id)!.label;
const node = (action: string, id: ArchNodeId) => screen.getByRole('button', { name: `${action}: ${label(id)}` });
const status = () => screen.getByRole('status');
const click = (name: string) => userEvent.click(screen.getByRole('button', { name }));

describe('Arquitectura · Recorrer', () => {
  beforeEach(() => localStorage.clear());

  it('arranca en Recorrer con la primera historia y su primer paso', () => {
    const { container } = render(<Arquitectura />);
    expect(screen.getByRole('heading', { level: 1, name: /Por dónde viajan los datos/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recorrer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: login.title })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(`Paso 1 de ${login.steps.length}`)).toBeInTheDocument();
    expect(status()).toHaveTextContent(`${label('web')} → ${label('firebase')}`);
    expect(screen.getByText(login.steps[0].message)).toBeInTheDocument();
    expect(container.querySelector('[data-edge="firebase|web"]')).toHaveAttribute('data-active', 'true');
    expect(container.querySelector('[data-packet="edge"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /test-me/ })).toHaveAttribute('href', '/test-me');
  });

  it('recorre la historia completa, con el conector y el porqué de cada paso', async () => {
    const { container } = render(<Arquitectura />);
    for (let i = 0; i < login.steps.length; i++) {
      const step = login.steps[i];
      const panel = screen.getByRole('region', { name: 'Detalle del paso' });
      expect(within(panel).getByText(step.message)).toBeInTheDocument();
      expect(within(panel).getByText(step.sources[0])).toBeInTheDocument();
      if (isInternalStep(step)) {
        expect(status()).toHaveTextContent(`Paso interno en ${label(step.from)}.`);
        expect(container.querySelector('[data-packet="internal"]')).toBeInTheDocument();
        expect(container.querySelector('[data-active]')).not.toBeInTheDocument();
      } else {
        expect(within(panel).getByText(new RegExp(`^${step.connector} ·`))).toBeInTheDocument();
      }
      if (step.why) expect(within(panel).getByText(step.why)).toBeInTheDocument();
      if (i < login.steps.length - 1) await click('Siguiente');
    }
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    await click('Anterior');
    expect(screen.getByText(`Paso ${login.steps.length - 1} de ${login.steps.length}`)).toBeInTheDocument();
    await click('Reiniciar');
    expect(screen.getByText(`Paso 1 de ${login.steps.length}`)).toBeInTheDocument();
  });

  it('avanza y retrocede con las flechas del teclado', async () => {
    render(<Arquitectura />);
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByText(`Paso 3 de ${login.steps.length}`)).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText(`Paso 2 de ${login.steps.length}`)).toBeInTheDocument();
    await userEvent.keyboard('{Control>}{ArrowRight}{/Control}');
    expect(screen.getByText(`Paso 2 de ${login.steps.length}`)).toBeInTheDocument();
  });

  it('abre y cierra la ficha de un componente, también con el teclado', async () => {
    render(<Arquitectura />);
    await userEvent.click(node('Ver ficha de', 'redis'));
    const card = screen.getByRole('region', { name: 'Ficha de Redis' });
    expect(within(card).getByText(/puerto 6379/)).toBeInTheDocument();
    expect(within(card).getByText(/C14/)).toBeInTheDocument();
    expect(within(card).getByText(/ADR 0003/)).toBeInTheDocument();
    expect(node('Ver ficha de', 'redis')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(card).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('region', { name: 'Ficha de Redis' })).not.toBeInTheDocument();

    node('Ver ficha de', 'media').focus();
    await userEvent.keyboard('{Enter}');
    expect(within(screen.getByRole('region', { name: 'Ficha de media-worker' })).getByText(/sin puerto/)).toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(screen.queryByRole('region', { name: 'Ficha de media-worker' })).not.toBeInTheDocument();
    await userEvent.keyboard('a');
    expect(screen.queryByRole('region', { name: 'Ficha de media-worker' })).not.toBeInTheDocument();
  });

  it('cambiar de historia vuelve al primer paso y cierra la ficha', async () => {
    render(<Arquitectura />);
    await userEvent.click(node('Ver ficha de', 'postgres'));
    await click('Siguiente');
    const other = ARCH_STORIES[3];
    await click(other.title);
    expect(screen.getByText(`Paso 1 de ${other.steps.length}`)).toBeInTheDocument();
    expect(screen.getByText(other.summary, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Ficha de/ })).not.toBeInTheDocument();
  });
});

describe('Arquitectura · Predecir', () => {
  beforeEach(() => localStorage.clear());

  it('pregunta sin revelar el destino y no deja avanzar sin responder', async () => {
    const { container } = render(<Arquitectura />);
    await click('Predecir');
    expect(status()).toHaveTextContent(`${login.steps[0].ask} Sale de ${label('web')}.`);
    expect(screen.queryByRole('region', { name: 'Detalle del paso' })).not.toBeInTheDocument();
    expect(screen.queryByText(login.steps[0].message)).not.toBeInTheDocument();
    expect(container.querySelector('[data-active]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-packet]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Anterior' })).not.toBeInTheDocument();
  });

  it('un acierto suma y revela la explicación; un fallo dice a dónde iba', async () => {
    render(<Arquitectura />);
    await click('Predecir');
    await userEvent.click(node('Responder', 'firebase'));
    expect(status()).toHaveTextContent(`¡Correcto! Va a ${label('firebase')}.`);
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('100');
    expect(screen.getByRole('region', { name: 'Detalle del paso' })).toBeInTheDocument();
    // ya respondido: el clic abre la ficha en vez de responder otra vez
    await userEvent.click(node('Ver ficha de', 'redis'));
    expect(screen.getByRole('region', { name: 'Ficha de Redis' })).toBeInTheDocument();
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('100');

    await click('Siguiente');
    await userEvent.click(node('Responder', 'identity'));
    expect(status()).toHaveTextContent(`No era ${label('identity')}: va a ${label('web')}.`);
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('100');
  });

  it('completa la historia, muestra el resultado y las preguntas relacionadas del test', async () => {
    render(<Arquitectura />);
    await click('Predecir');
    for (let i = 0; i < login.steps.length; i++) {
      const step = login.steps[i];
      if (isInternalStep(step)) expect(status()).toHaveTextContent(`Paso interno en ${label(step.from)}.`);
      else await userEvent.click(node('Responder', step.to));
      await click(i < login.steps.length - 1 ? 'Siguiente' : 'Ver resultado');
    }
    const asked = login.steps.filter((s) => !isInternalStep(s)).length;
    expect(status()).toHaveTextContent(`Historia completa: ${asked} de ${asked} aciertos.`);
    expect(within(screen.getByRole('region', { name: 'Resultado' })).getByRole('heading')).toHaveTextContent(
      `${asked} de ${asked} saltos acertados`,
    );
    expect(screen.getByRole('button', { name: 'Ver resultado' })).toBeDisabled();

    for (let i = 0; i < login.quizIds.length; i++) {
      const prompt = screen.getByRole('heading', { level: 2, name: /\?$/ }).textContent;
      const q = quizQuestions.find((x) => x.prompt === prompt)!;
      expect(login.quizIds).toContain(q.id);
      const option = screen.getAllByRole('button', { name: /^Opción/ }).find((b) => b.getAttribute('aria-label')!.endsWith(`: ${q.options[q.answer]}`))!;
      await userEvent.click(option);
      await click(i < login.quizIds.length - 1 ? 'Siguiente pregunta' : 'Ver resultados');
    }
    expect(screen.getByText(`Preguntas del test: ${login.quizIds.length} de ${login.quizIds.length} correctas.`)).toBeInTheDocument();

    await click('Reiniciar');
    expect(status()).toHaveTextContent(login.steps[0].ask);
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('0');
  });

  it('volver a Recorrer reinicia la historia', async () => {
    render(<Arquitectura />);
    await click('Predecir');
    await userEvent.click(node('Responder', 'firebase'));
    await click('Recorrer');
    expect(screen.queryByLabelText('Puntos')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(`${label('web')} → ${label('firebase')}`);
  });
});
