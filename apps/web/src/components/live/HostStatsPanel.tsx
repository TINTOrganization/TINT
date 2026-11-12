import type { HostStats } from '../../lib/streamProtocol';
import { formatBitrate, LAYER_LABELS } from '../../lib/streamProtocol';

/** Estadísticas del host (`host_stats`, 1 Hz): bitrate y espectadores por capa, NACKs y PLIs. */
export function HostStatsPanel({ stats, viewerCount }: { stats: HostStats | null; viewerCount: number | null }) {
  const layers = stats ? [...stats.layers].sort((a, b) => 'hml'.indexOf(a.rid) - 'hml'.indexOf(b.rid)) : [];
  return (
    <section aria-labelledby="host-stats-title">
      <h2 id="host-stats-title" className="text-[15px] font-semibold text-white">
        Estadísticas
      </h2>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-white/5 px-2 py-2">
          <dt className="text-[11px] uppercase tracking-wide text-tint-muted">Espectadores</dt>
          <dd className="text-lg font-semibold tabular-nums text-white">{viewerCount ?? 0}</dd>
        </div>
        <div className="rounded-xl bg-white/5 px-2 py-2">
          <dt className="text-[11px] uppercase tracking-wide text-tint-muted">NACKs</dt>
          <dd className="text-lg font-semibold tabular-nums text-white">{stats?.nacks ?? 0}</dd>
        </div>
        <div className="rounded-xl bg-white/5 px-2 py-2">
          <dt className="text-[11px] uppercase tracking-wide text-tint-muted">Keyframes pedidos</dt>
          <dd className="text-lg font-semibold tabular-nums text-white">{stats?.plis ?? 0}</dd>
        </div>
      </dl>
      {layers.length === 0 ? (
        <p className="mt-3 text-[13px] text-tint-muted">Las capas aparecen cuando el servidor recibe tu vídeo.</p>
      ) : (
        <table className="mt-3 w-full text-left text-[13px]">
          <caption className="sr-only">Capas del simulcast</caption>
          <thead className="text-[11px] uppercase tracking-wide text-tint-muted">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Capa
              </th>
              <th scope="col" className="py-1 font-medium">
                Bitrate
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Viendo
              </th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l) => (
              <tr key={l.rid} className="border-t border-white/5">
                <th scope="row" className="py-1.5 font-normal text-white">
                  <span
                    aria-hidden="true"
                    className={`mr-2 inline-block h-2 w-2 rounded-full ${l.active ? 'bg-emerald-400' : 'bg-white/25'}`}
                  />
                  {LAYER_LABELS[l.rid]}
                  {!l.active && <span className="text-tint-muted"> · inactiva</span>}
                </th>
                <td className="py-1.5 tabular-nums">{formatBitrate(l.bitrate_bps)}</td>
                <td className="py-1.5 text-right tabular-nums">{l.viewers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
