"use client";

import * as React from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, EquityPoint, Interval, SimulatedFill } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TradingChartsProps {
  candles: Candle[];
  symbol: string;
  interval: Interval;
  fills: SimulatedFill[];
  equityCurve: EquityPoint[];
  startingCapital: string;
}

// Convert decimal strings to JS numbers ONLY at chart plotting time.
function toPlotNumber(decimalStr: string): number {
  return Number(decimalStr);
}

function getCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

export function TradingCharts({
  candles,
  symbol,
  interval,
  fills,
  equityCurve,
  startingCapital,
}: TradingChartsProps) {
  const [equityMode, setEquityMode] = React.useState<"equity" | "pnl">("equity");
  const ohlcContainerRef = React.useRef<HTMLDivElement | null>(null);
  const equityContainerRef = React.useRef<HTMLDivElement | null>(null);

  // OHLC Candlestick Chart + Simulated Fill Markers anchored to actual fill_time (UTC Unix seconds)
  React.useEffect(() => {
    const el = ohlcContainerRef.current;
    if (!el || candles.length === 0) return;

    const positive = getCssVar("--positive", "#15803d");
    const negative = getCssVar("--negative", "#b91c1c");
    const textMuted = getCssVar("--text-muted", "#64748b");
    const border = getCssVar("--border", "#e2e8f0");

    const chart: IChartApi = createChart(el, {
      height: 320,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: textMuted,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        timeVisible: interval === "15m",
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: "#94a3b8", style: LineStyle.Dashed },
        horzLine: { color: "#94a3b8", style: LineStyle.Dashed },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: positive,
      downColor: negative,
      borderVisible: false,
      wickUpColor: positive,
      wickDownColor: negative,
    });

    const ohlcData = [...candles]
      .sort((a, b) => a.time - b.time)
      .map((c) => ({
        time: c.time as UTCTimestamp,
        open: toPlotNumber(c.open),
        high: toPlotNumber(c.high),
        low: toPlotNumber(c.low),
        close: toPlotNumber(c.close),
      }));

    candleSeries.setData(ohlcData);

    // Anchor BUY/SELL markers strictly to actual simulated execution fill_time (never signal_time)
    if (fills.length > 0) {
      const markers: SeriesMarker<Time>[] = fills
        .map((fill) => ({
          time: fill.fill_time as UTCTimestamp as Time,
          position: fill.side === "BUY" ? ("belowBar" as const) : ("aboveBar" as const),
          color: fill.side === "BUY" ? positive : negative,
          shape: fill.side === "BUY" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: `${fill.side} ${fill.units} @ ${fill.price}`,
        }))
        .sort((a, b) => Number(a.time) - Number(b.time));

      createSeriesMarkers(candleSeries, markers);
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      if (el.clientWidth > 0) {
        chart.applyOptions({ width: el.clientWidth });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [candles, fills, interval]);

  // Equity Curve / Cumulative PnL Chart
  React.useEffect(() => {
    const el = equityContainerRef.current;
    if (!el || equityCurve.length === 0) return;

    const accent = getCssVar("--accent", "#1e3a5f");
    const positive = getCssVar("--positive", "#15803d");
    const negative = getCssVar("--negative", "#b91c1c");
    const textMuted = getCssVar("--text-muted", "#64748b");
    const border = getCssVar("--border", "#e2e8f0");

    const startCap = toPlotNumber(startingCapital);
    const lastEquity = toPlotNumber(equityCurve[equityCurve.length - 1].equity);
    const isPositivePnl = lastEquity >= startCap;

    const chart: IChartApi = createChart(el, {
      height: 260,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: textMuted,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        timeVisible: interval === "15m",
        secondsVisible: false,
      },
    });

    const lineSeries = chart.addSeries(LineSeries, {
      color: equityMode === "equity" ? accent : isPositivePnl ? positive : negative,
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    const seriesData = [...equityCurve]
      .sort((a, b) => a.time - b.time)
      .map((point) => ({
        time: point.time as UTCTimestamp,
        value:
          equityMode === "equity"
            ? toPlotNumber(point.equity)
            : Number((toPlotNumber(point.equity) - startCap).toFixed(2)),
      }));

    lineSeries.setData(seriesData);

    if (equityMode === "equity") {
      lineSeries.createPriceLine({
        price: startCap,
        color: "#94a3b8",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Start",
      });
    } else {
      lineSeries.createPriceLine({
        price: 0,
        color: "#94a3b8",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "0.00",
      });
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      if (el.clientWidth > 0) {
        chart.applyOptions({ width: el.clientWidth });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [equityCurve, equityMode, interval, startingCapital]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
          <div>
            <CardTitle>
              {symbol} OHLC ({interval}) &amp; Simulated Fills
            </CardTitle>
            <CardDescription>
              BUY/SELL markers anchored to actual execution fill_time (UTC Unix seconds).
            </CardDescription>
          </div>
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[var(--text-muted)] underline decoration-[var(--border)] underline-offset-4 hover:text-[var(--text)]"
          >
            Charts by TradingView
          </a>
        </CardHeader>
        <CardContent>
          {candles.length === 0 ? (
            <div className="flex h-[320px] items-center justify-center rounded-sm border border-dashed border-[var(--border)] text-sm text-[var(--text-muted)]">
              No synthetic candle series loaded yet.
            </div>
          ) : (
            <div
              ref={ohlcContainerRef}
              className="w-full"
              aria-label="OHLC Candlestick Chart with Simulated Fill Markers"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
          <div>
            <CardTitle>
              {equityMode === "equity" ? "Equity Curve" : "Cumulative Net PnL"}
            </CardTitle>
            <CardDescription>
              Mark-to-market simulated equity vs starting capital ({startingCapital}).
            </CardDescription>
          </div>
          <div className="flex items-center gap-1 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setEquityMode("equity")}
              className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                equityMode === "equity"
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              Equity
            </button>
            <button
              type="button"
              onClick={() => setEquityMode("pnl")}
              className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                equityMode === "pnl"
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              Net PnL
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {equityCurve.length === 0 ? (
            <div className="flex h-[260px] items-center justify-center rounded-sm border border-dashed border-[var(--border)] text-sm text-[var(--text-muted)]">
              Run a backtest to render the equity curve.
            </div>
          ) : (
            <div
              ref={equityContainerRef}
              className="w-full"
              aria-label="Equity Curve and Net PnL Chart"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
