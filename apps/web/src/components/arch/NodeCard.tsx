import { ARCH_KIND_LABELS, type ArchConnector, type ArchNode } from '../../data/architecture';
import { Button } from '../ui/Button';

/** Ficha de un componente: qué hace, qué datos son suyos y por qué conectores habla. */
export default function NodeCard({
  node,
  connectors,
  onClose,
}: {
  node: ArchNode;
  connectors: readonly ArchConnector[];
  onClose: () => void;
}) {
  const own = connectors.filter((c) => c.links.some(([a, b]) => a === node.id || b === node.id));

  return (
    <section aria-label={`Ficha de ${node.label}`} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-tint-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-tint-accent">{ARCH_KIND_LABELS[node.kind]}</p>
          <h3 className="mt-1 break-words text-lg font-bold text-white">{node.label}</h3>
          <p className="mt-1 text-xs text-tint-muted">
            {node.stack}
            {node.port ? ` · puerto ${node.port}` : ' · sin puerto'}
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>

      <p className="text-sm leading-relaxed text-tint-text">{node.role}</p>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Datos a su cargo</p>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-tint-text">
          {node.owns.map((o) => (
            <li key={o} className="break-words">
              {o}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Conectores</p>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-tint-text">
          {own.map((c) => (
            <li key={c.id}>
              <span className="font-semibold text-tint-accentHover">{c.id}</span> · {c.label}
            </li>
          ))}
        </ul>
      </div>

      {node.adrs.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Decisiones (docs/adr)</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-tint-text">
            {node.adrs.map((a) => (
              <li key={a}>ADR {a}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
