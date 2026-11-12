import { NextResponse } from "next/server";
import pino from "pino";

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";

import {
  getActiveProviderConnections,
  getLatestLogicalCalls,
  getProviderMetrics,
  type ProviderMetricRow,
} from "@/lib/db/callLogStats";
import { foldMetricRowsByFamily } from "@/lib/providerFamilyAgg";
import {
  isCurrentActiveFailure,
  resolveTopologyErrorWindowMs,
} from "@/lib/usage/topologyErrorProvider";
import { toNumber, toNumberOrNull } from "@/shared/utils/numeric";

const logger = pino({ name: "provider-metrics-api" });

interface ProviderMetric {
  totalRequests: number;
  totalSuccesses: number;
  successRate: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastErrorStatus: number | null;
}

function toProviderMetric(row: ProviderMetricRow): ProviderMetric {
  const totalRequests = toNumber(row.totalRequests);
  const totalSuccesses = toNumber(row.totalSuccesses);
  return {
    totalRequests,
    totalSuccesses,
    successRate: totalRequests > 0 ? Math.round((totalSuccesses / totalRequests) * 100) : 0,
    avgLatencyMs: toNumberOrNull(row.avgLatencyMs),
    lastRequestAt: typeof row.lastRequestAt === "string" ? row.lastRequestAt : null,
    lastErrorAt: typeof row.lastErrorAt === "string" ? row.lastErrorAt : null,
    lastStatus: row.lastStatus == null ? null : toNumber(row.lastStatus),
    lastErrorStatus: row.lastErrorStatus == null ? null : toNumber(row.lastErrorStatus),
  };
}

/**
 * GET /api/provider-metrics — Aggregate per-provider stats from call_logs
 * Returns per-provider metrics, per-family aggregates (`familyMetrics`) and
 * topology recency/error hints for dashboard visualization.
 */
export async function GET() {
  try {
    const rows = getProviderMetrics();
    const activeConnections = getActiveProviderConnections();
    const activeConnectionProviders = new Map(
      activeConnections.map((connection) => [connection.id, connection.provider])
    );
    const providersWithActiveConnection = new Set(
      activeConnections.map((connection) => connection.provider)
    );
    const latestCallByProvider = new Map(
      getLatestLogicalCalls().map((call) => [call.provider, call])
    );
    const errorWindowMs = resolveTopologyErrorWindowMs(
      process.env.OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS
    );
    const nowMs = Date.now();

    const metrics: Record<string, ProviderMetric> = {};
    let lastProvider = "";
    let lastProviderTs = 0;
    let errorProvider = "";
    let errorProviderTs = 0;

    for (const row of rows) {
      const provider =
        typeof row.provider === "string" && row.provider.trim().length > 0
          ? row.provider
          : "unknown";
      const metric = toProviderMetric(row);
      metrics[provider] = metric;
      const { lastRequestAt } = metric;

      const requestTs = lastRequestAt ? Date.parse(lastRequestAt) : 0;
      if (Number.isFinite(requestTs) && requestTs > lastProviderTs) {
        lastProvider = provider;
        lastProviderTs = requestTs;
      }

      // The badge follows the provider's newest call, and only when that call
      // failed, is inside the window, and belongs to a connection that is still
      // active. A recovered provider, a disabled connection, a no-auth provider
      // with no connection, and a stale failure stay off the badge (#3619).
      const latest = latestCallByProvider.get(provider);
      const latestStatus = latest?.status == null ? null : toNumber(latest.status);
      const isCurrentlyInError =
        latestStatus !== null && (latestStatus < 200 || latestStatus >= 400);
      const errorTs = isCurrentlyInError && latest?.timestamp ? Date.parse(latest.timestamp) : 0;
      if (
        isCurrentActiveFailure({
          connectionId: latest?.connectionId,
          provider,
          failedAtMs: errorTs,
          nowMs,
          windowMs: errorWindowMs,
          activeConnectionProviders,
          providersWithActiveConnection,
        }) &&
        errorTs > errorProviderTs
      ) {
        errorProvider = provider;
        errorProviderTs = errorTs;
      }
    }

    // Per-member rows stay in `metrics` (one per topology node); connection
    // families (e.g. kimi-coding + kimi-coding-apikey) get their folded totals
    // under `familyMetrics`, keyed by the canonical id (#15005).
    const familyMetrics = Object.fromEntries(
      foldMetricRowsByFamily(rows).map((row) => [row.provider, toProviderMetric(row)])
    );

    return NextResponse.json({
      metrics,
      familyMetrics,
      topology: {
        providers: Object.keys(metrics),
        lastProvider,
        errorProvider,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load provider metrics");
    return NextResponse.json(buildErrorBody(500, "Failed to load provider metrics"), {
      status: 500,
    });
  }
}
