<script lang="ts">
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Activity, CircleStop, LoaderCircle } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { connectorDefinitions } from "@/data/connectors/definitions";
  import { formatDateTime } from "@/shared/format/financial";

  // Homelab-only: backed by /api/homelab/sync-runs in apps/worker/src/homelab.ts.
  // On a Cloudflare deploy that endpoint 404s and this panel stays hidden.
  type SyncRun = {
    kind: "lock" | "einvoice" | "tdcc";
    id: string;
    connectorId: string;
    status: string;
    at: string;
  };

  let { api }: { api: ApiClient } = $props();

  const queryKey = ["homelab-sync-runs"];
  const queryClient = useQueryClient();
  const runs = createQuery({
    queryKey,
    queryFn: () => api.get<SyncRun[]>("/api/homelab/sync-runs"),
    refetchInterval: 5000,
    retry: false,
  });

  let confirming = $state<string | null>(null);
  const stop = createMutation({
    mutationFn: (run: SyncRun) =>
      api.post("/api/homelab/sync-runs/stop", { kind: run.kind, id: run.id }),
    onSettled: () => {
      confirming = null;
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
  });

  const statusLabels: Record<string, string> = {
    manual: "手動同步",
    scheduled: "排程同步",
    queued: "排隊中",
    initializing: "準備中",
    processing: "同步中",
    promoting: "寫入中",
  };
  const title = (id: string) =>
    connectorDefinitions.find((item) => item.id === id)?.title ?? id;
  const key = (run: SyncRun) => `${run.kind}:${run.id}`;
</script>

{#if !$runs.isError}
  <Card as="section" class="overflow-hidden border-border shadow-xs">
    <div
      class="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-card px-5 py-4"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-steel/10 text-steel"
        >
          <Activity class="size-5" />
        </span>
        <div>
          <h2 class="font-semibold">正在同步</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            卡住的同步可以在這裡停止，停止後即可重新同步。
          </p>
        </div>
      </div>
      <span
        class={`rounded-full px-3 py-1.5 text-sm font-semibold ${$runs.data?.length ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}
      >
        {$runs.data?.length ?? 0} 個進行中
      </span>
    </div>

    {#if $runs.isPending}
      <p class="p-5 text-sm text-muted-foreground">載入中…</p>
    {:else if !$runs.data?.length}
      <p class="p-5 text-sm text-muted-foreground">目前沒有正在同步的項目。</p>
    {:else}
      <ul class="divide-y divide-border">
        {#each $runs.data as run (key(run))}
          <li
            class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
          >
            <div class="flex min-w-0 items-center gap-3">
              <LoaderCircle class="size-4 shrink-0 animate-spin text-steel" />
              <div class="min-w-0">
                <p class="truncate font-medium">{title(run.connectorId)}</p>
                <p class="text-sm text-muted-foreground">
                  {statusLabels[run.status] ?? (run.status || "同步中")} ·
                  {run.kind === "lock" ? "鎖定至" : "更新於"}
                  {formatDateTime(run.at)}
                </p>
              </div>
            </div>
            {#if confirming === key(run)}
              <div class="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => (confirming = null)}>取消</Button
                >
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={$stop.isPending}
                  onclick={() => $stop.mutate(run)}>確定停止</Button
                >
              </div>
            {:else}
              <Button
                size="sm"
                variant="outline"
                onclick={() => (confirming = key(run))}
                ><CircleStop />停止</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if $stop.isError}
      <p class="border-t border-border px-5 py-3 text-sm text-coral">
        停止失敗：{$stop.error?.message}
      </p>
    {/if}
    <p
      class="border-t border-border bg-muted/50 px-5 py-3 text-xs text-muted-foreground"
    >
      停止只會清除同步狀態；已開啟的瀏覽器會在逾時後自行結束，急著中斷請重啟服務。
    </p>
  </Card>
{/if}
