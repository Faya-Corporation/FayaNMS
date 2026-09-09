"use client";

import { forwardRef } from "react";

interface ChartSummaryProps {
  /**
   * REQUIRED concise, honest description of what the chart shows — exposed
   * as the accessible name of the role="img" region. Use real values from
   * the view's data where available ("Availability trend, averaged 95.4
   * percent over the last 7 days"); a static description is acceptable when
   * no dynamic value exists ("Capacity forecast: days-to-exhaustion per
   * interface").
   */
  "aria-label": string;
  /**
   * Optional longer summary for screen-reader users (methodology, notable
   * values, how to read the chart). Rendered inside a visually-hidden div
   * positioned AFTER the chart region. NOTE: it must live OUTSIDE the
   * role="img" element — content inside role="img" is treated as
   * presentational and would never be announced.
   */
  summary?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Accessible chart wrapper (Phase 8-b, WCAG 1.1.1 Non-text Content).
 *
 * Recharts SVGs are opaque to assistive technology (hundreds of unlabeled
 * paths). This wrapper presents the whole chart as a single role="img" with
 * a meaningful accessible name, plus an optional sr-only longer summary.
 * Renders two plain stacked <div>s — no styling is applied, so it is a
 * drop-in around any <ResponsiveContainer> (or bare chart) usage; forward
 * layout classes via className.
 *
 * Keep the label honest: never fabricate numbers that are not in view data.
 */
export const ChartSummary = forwardRef<HTMLDivElement, ChartSummaryProps>(
  function ChartSummary(
    { "aria-label": label, summary, children, className },
    ref
  ) {
    return (
      <div className={className} ref={ref}>
        <div aria-label={label} role="img">
          {children}
        </div>
        {summary !== undefined && summary !== null && (
          <div className="sr-only">{summary}</div>
        )}
      </div>
    );
  }
);
