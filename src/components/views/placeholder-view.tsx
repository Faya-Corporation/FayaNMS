"use client";

import { Construction } from "lucide-react";

import { EmptyState } from "@/components/domain/empty-state";
import { PageHeader } from "@/components/domain/page-header";
import type { ViewMeta } from "@/lib/navigation/registry";
import type { ViewKey } from "@/stores/navigation";

interface PlaceholderViewProps {
  viewKey: ViewKey;
  meta: ViewMeta;
}

/**
 * Honest placeholder for modules that are not implemented yet: the real
 * title/description from the registry plus the roadmap phase that will
 * deliver it. No fake data, ever.
 */
export function PlaceholderView({ viewKey, meta }: PlaceholderViewProps) {
  void viewKey;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader description={meta.description} title={meta.title} />
      <EmptyState
        className="py-16"
        description="Nothing here is simulated — this module ships with its roadmap phase. Use the sidebar, the ⌘K palette or the dashboard to continue exploring the live slice."
        icon={Construction}
        title={`This module arrives in ${meta.phase}`}
      />
    </div>
  );
}
