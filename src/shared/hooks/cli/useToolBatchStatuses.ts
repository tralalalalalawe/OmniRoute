"use client";

import { useCallback, useEffect, useState } from "react";
import type { ToolBatchStatusMap } from "@/shared/types/cliBatchStatus";
import { isLocalOnlyCliStatusResponse } from "@/shared/utils/cliCompanion";

export interface UseToolBatchStatusesResult {
  statuses: ToolBatchStatusMap | null;
  loading: boolean;
  error: string | null;
  /** Public dashboard: the status route answered 403 LOCAL_ONLY. Not a probe failure. */
  localOnly: boolean;
  refetch: () => void;
}

export function useToolBatchStatuses(): UseToolBatchStatusesResult {
  const [statuses, setStatuses] = useState<ToolBatchStatusMap | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState<boolean>(false);

  const fetchStatuses = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/cli-tools/all-statuses${forceRefresh ? "?refresh=true" : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status));
        setStatuses(null);
        if (isLocalOnlyCliStatusResponse(res.status, text)) {
          setLocalOnly(true);
          setError(null);
          return;
        }
        setLocalOnly(false);
        setError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return;
      }
      const data = (await res.json()) as ToolBatchStatusMap;
      setLocalOnly(false);
      setStatuses(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalOnly(false);
      setError(msg);
      setStatuses(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refetch = useCallback(() => {
    void fetchStatuses(true);
  }, [fetchStatuses]);

  useEffect(() => {
    void (async () => {
      await fetchStatuses();
    })();

    function handleFocus() {
      void fetchStatuses();
    }

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [fetchStatuses]);

  return { statuses, loading, error, localOnly, refetch };
}
