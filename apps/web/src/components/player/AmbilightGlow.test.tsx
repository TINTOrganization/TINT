import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBILIGHT_PREF_KEY, AmbilightGlow } from './AmbilightGlow';
import { useAmbilight } from '../../hooks/useAmbilight';

vi.mock('../../hooks/useAmbilight', () => ({ useAmbilight: vi.fn() }));
const mockedUseAmbilight = vi.mocked(useAmbilight);

const COLORS = { top: '#112233', right: '#445566', bottom: '#778899', left: '#aabbcc' };

function renderGlow(url: string | null = 'https://blob/m1/ambilight.json') {
  const videoRef = createRef<HTMLVideoElement>();
  const utils = render(
    <AmbilightGlow url={url} videoRef={videoRef}>
      <div>Reproductor</div>
    </AmbilightGlow>,
  );
  return { ...utils, videoRef };
}

describe('AmbilightGlow', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedUseAmbilight.mockImplementation((_url, _ref, opts) => (opts?.enabled === false ? null : COLORS));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockedUseAmbilight.mockReset();
  });

  it('pinta un brillo por lado detrás del reproductor', () => {
    renderGlow();
    expect(screen.getByText('Reproductor')).toBeInTheDocument();
    const glow = screen.getByTestId('ambilight-glow');
    expect(glow).toHaveAttribute('aria-hidden', 'true');
    expect(glow).toHaveAttribute('data-visible', 'true');
    const sides = Object.fromEntries(
      Array.from(glow.querySelectorAll<HTMLElement>('[data-side]')).map((el) => [el.dataset.side, el.style.backgroundColor]),
    );
    expect(sides).toEqual({
      top: 'rgb(17, 34, 51)',
      right: 'rgb(68, 85, 102)',
      bottom: 'rgb(119, 136, 153)',
      left: 'rgb(170, 187, 204)',
    });
  });

  it('separa la clase responsive de la transición (sm:-top-8 y transition-[…] son clases distintas)', () => {
    renderGlow();
    const glow = screen.getByTestId('ambilight-glow');
    expect(glow.classList.contains('sm:-top-8')).toBe(true);
    expect(glow.classList.contains('transition-[background-color,opacity]')).toBe(true);
  });

  it('sin URL no hay brillo ni interruptor', () => {
    mockedUseAmbilight.mockReturnValue(null);
    renderGlow(null);
    expect(screen.getByText('Reproductor')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('ambilight-glow')).toHaveAttribute('data-visible', 'false');
  });

  it('el interruptor apaga el brillo y recuerda la preferencia', () => {
    const { unmount } = renderGlow();
    const toggle = screen.getByRole('switch', { name: 'Ambilight' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ambilight-glow')).toHaveAttribute('data-visible', 'false');
    expect(localStorage.getItem(AMBILIGHT_PREF_KEY)).toBe('off');
    expect(mockedUseAmbilight).toHaveBeenLastCalledWith(
      'https://blob/m1/ambilight.json',
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    unmount();
    renderGlow();
    expect(screen.getByRole('switch', { name: 'Ambilight' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('switch', { name: 'Ambilight' }));
    expect(localStorage.getItem(AMBILIGHT_PREF_KEY)).toBe('on');
  });

  it('con prefers-reduced-motion no interpola ni anima la transición', () => {
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: q.includes('reduce') })));
    renderGlow();
    expect(mockedUseAmbilight).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ interpolate: false }),
    );
  });

  it('sin matchMedia interpola', () => {
    vi.stubGlobal('matchMedia', undefined);
    renderGlow();
    expect(mockedUseAmbilight).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ interpolate: true, enabled: true }),
    );
  });
});
