/**
 * Issue 6406 — the hunt detail chart (lightweight-charts).
 *
 * A line series over the symbol's trailing closes with horizontal price
 * lines for the recommendation levels: entry range / stop-loss /
 * take-profit for entries, cost basis / exit price for exits. Colours come
 * from the theme tokens at runtime (getComputedStyle), so the chart
 * follows the app's light/dark theme like every other surface.
 *
 * The chart's numbers are also printed as text in the detail section
 * (the accessible alternative — a canvas chart is never the only place a
 * level appears).
 */
import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

export interface OpportunityHuntChartProps {
  symbol: string;
  /** Trailing closes, oldest → newest. */
  closes: readonly number[];
  /** Trading-day labels matching closes, oldest → newest. */
  labels: readonly string[];
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Held cost basis — exits only. */
  entryPrice: number | null;
  lastClose: number;
}

function tokenColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function OpportunityHuntChart(props: OpportunityHuntChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const border = tokenColor("--color-border-subtle", "#e5e5e5");
    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: 260,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: tokenColor("--color-text-muted", "#888888"),
      },
      grid: {
        vertLines: { color: border },
        horzLines: { color: border },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: false },
    });
    const series = chart.addSeries(LineSeries, {
      color: tokenColor("--color-accent", "#2962ff"),
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const n = Math.min(props.closes.length, props.labels.length);
    series.setData(
      props.closes
        .slice(0, n)
        .map((value, i) => ({ time: props.labels[i] as Time, value })),
    );
    // Replace the price lines: remove the previous set, then draw the
    // current recommendation levels (entries, exits, or both).
    for (const line of linesRef.current) series.removePriceLine(line);
    const lines: Array<{ price: number; color: string; title: string }> = [];
    if (props.entryLow !== null) {
      lines.push({
        price: props.entryLow,
        color: tokenColor("--color-success", "#26a69a"),
        title: "Entry low",
      });
    }
    if (props.entryHigh !== null) {
      lines.push({
        price: props.entryHigh,
        color: tokenColor("--color-success", "#26a69a"),
        title: "Entry high",
      });
    }
    if (props.stopLoss !== null) {
      lines.push({
        price: props.stopLoss,
        color: tokenColor("--color-danger", "#ef5350"),
        title: "Stop-loss",
      });
    }
    if (props.takeProfit !== null) {
      lines.push({
        price: props.takeProfit,
        color: tokenColor("--color-accent", "#2962ff"),
        title: "Take-profit",
      });
    }
    if (props.entryPrice !== null) {
      lines.push({
        price: props.entryPrice,
        color: tokenColor("--color-warning", "#ff9800"),
        title: "Cost basis",
      });
    }
    linesRef.current = lines.map((line) =>
      series.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: line.title,
      }),
    );
    chart.timeScale().fitContent();
  }, [
    props.closes,
    props.labels,
    props.entryLow,
    props.entryHigh,
    props.stopLoss,
    props.takeProfit,
    props.entryPrice,
  ]);

  if (props.closes.length < 2) {
    return (
      <p>
        Not enough closes to chart {props.symbol} — the recommendation levels
        below are still the hunt&apos;s numbers.
      </p>
    );
  }
  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`Trailing closes for ${props.symbol}, latest close ${props.lastClose.toFixed(2)}, with the entry, stop-loss, take-profit, and exit levels marked`}
      style={{ width: "100%", minWidth: 0 }}
    />
  );
}
