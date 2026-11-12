import { ARCH_MODE_LABELS, type ArchConnector, type ArchNode } from '../../data/architecture';
import type { ArchStep } from '../../data/architectureStories';

const Sources = ({ sources }: { sources: string[] }) => (
  <div>
    <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Dónde encontrarlo</p>
    <ul className="mt-2 flex flex-wrap gap-2">
      {sources.map((src) => (
        <li key={src}>
          <code className="break-all rounded-lg bg-black/30 px-2 py-1 text-xs text-tint-accentHover">{src}</code>
        </li>
      ))}
    </ul>
  </div>
);

/** Explicación de un paso ya resuelto: qué viaja, por dónde y por qué. */
export default function StepPanel({
  step,
  from,
  to,
  connector,
}: {
  step: ArchStep;
  from: ArchNode;
  to: ArchNode;
  connector: ArchConnector | null;
}) {
  return (
    <section aria-label="Detalle del paso" className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-tint-card/70 p-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">
          {connector ? `${from.label} → ${to.label}` : `Paso interno en ${from.label}`}
        </p>
        <p className="mt-2 break-words font-mono text-sm font-semibold leading-snug text-white">{step.message}</p>
      </div>

      <p className="text-sm leading-relaxed text-tint-text">{step.detail}</p>

      {connector && (
        <div className="rounded-xl bg-black/20 p-3">
          <p className="text-xs font-semibold text-tint-accentHover">
            {connector.id} · {connector.label}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-tint-text">{connector.protocol}</p>
          <p className="mt-1 text-xs text-tint-muted">{ARCH_MODE_LABELS[connector.mode]}</p>
        </div>
      )}

      {step.why && (
        <div className="border-l-2 border-tint-accent pl-3">
          <p className="text-xs font-medium uppercase tracking-wide text-tint-accent">Por qué así</p>
          <p className="mt-1 text-sm leading-relaxed text-tint-text">{step.why}</p>
        </div>
      )}

      <Sources sources={step.sources} />
    </section>
  );
}
