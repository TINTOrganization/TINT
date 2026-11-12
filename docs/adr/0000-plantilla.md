# ADR NNNN — Título corto de la decisión

| Campo | Valor |
| :--- | :--- |
| **Estado** | Propuesta · Aceptada · Reemplazada por [NNNN](NNNN-nombre.md) · Obsoleta |
| **Fecha** | AAAA-MM-DD (commit que la implementa) |
| **Dominios afectados** | `services/…`, `apps/web`, infra |

## Contexto
¿Qué problema hay? ¿Qué requisitos, mediciones, incidentes o restricciones obligan a decidir? Cita evidencia (pruebas, benchmarks, hallazgos del bug hunting).

## Decisión
Qué se hace, en presente y con nombres reales: archivos, paquetes, claves Redis, tablas, rutas y códigos.

```mermaid
flowchart LR
    A["Componente A"] -- "conector" --> B["Componente B"]
```

## Alternativas consideradas
| Alternativa | Por qué no |
| :--- | :--- |
| … | … |

## Consecuencias
**Positivas**
- …

**Negativas**
- …

**Riesgos**
- …

## Referencias
- Código: `ruta/al/archivo`
- Documentos: [`docs/…`](../…)
- Commits: `abc1234` tipo(alcance): descripción
