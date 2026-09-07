"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BookmarkPlus, Check } from "lucide-react";

import { FilterChip } from "@/components/domain/filter-chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface SavedViewsStripProps {
  /** Persisted views for this surface ({ id, name, filters } slices). */
  views: { id: string; name: string }[];
  /** The view whose filters exactly match the current state (ringed). */
  activeId?: string | null;
  /** Disabled while the surface has no active filters (nothing to save). */
  saveDisabled: boolean;
  onApply: (id: string) => void;
  onRemove: (id: string) => void;
  /** Persists the named snapshot; returns the saved view's name or null. */
  onSave: (name: string) => string | null;
  className?: string;
}

/**
 * Saved-views strip (Phase 9-b) — the devices-view pattern generalized:
 * removable FilterChips (≥24px remove hit area via the invisible
 * after:-inset-1 expansion), a bookmark "Save view" button opening a
 * shadcn Dialog name prompt, and a muted hint while the surface has no
 * saved views. Fully i18n'd through the "savedViews" namespace.
 */
export function SavedViewsStrip({
  views,
  activeId,
  saveDisabled,
  onApply,
  onRemove,
  onSave,
  className,
}: SavedViewsStripProps) {
  const t = useTranslations("savedViews");
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");

  const handleSave = () => {
    const createdName = onSave(name);
    if (createdName) {
      setName("");
      setDialogOpen(false);
      toast({
        title: t("savedToastTitle"),
        description: t("savedToastBody", { name: createdName }),
      });
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {views.map((view) => (
        <span key={view.id} className="relative inline-flex items-center">
          <button
            aria-label={t("applyAria", { name: view.name })}
            className={cn(
              "rounded-md transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent",
              activeId === view.id && "ring-2 ring-primary/40"
            )}
            onClick={() => onApply(view.id)}
            type="button"
          >
            <FilterChip label={t("chipLabel")} value={view.name} />
          </button>
          <button
            aria-label={t("removeAria", { name: view.name })}
            className="absolute -end-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors after:absolute after:-inset-1 after:rounded-full after:content-[''] hover:text-danger"
            onClick={() => {
              onRemove(view.id);
              toast({ title: t("deleted"), description: t("deletedBody", { name: view.name }) });
            }}
            type="button"
          >
            <span aria-hidden="true" className="text-[9px] leading-none">
              ✕
            </span>
          </button>
        </span>
      ))}

      <Button disabled={saveDisabled} onClick={() => setDialogOpen(true)} size="sm" variant="outline">
        <BookmarkPlus aria-hidden="true" />
        {t("saveView")}
      </Button>
      {views.length === 0 && saveDisabled && (
        <span className="text-xs text-muted-foreground">{t("noViews")}</span>
      )}

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("saveViewTitle")}</DialogTitle>
            <DialogDescription>{t("saveViewDescription")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >
            <label className="sr-only" htmlFor="saved-view-name">
              {t("viewName")}
            </label>
            <Input
              autoFocus
              id="saved-view-name"
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("viewNamePlaceholder")}
              value={name}
            />
            <DialogFooter className="mt-4">
              <Button
                onClick={() => setDialogOpen(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("cancel")}
              </Button>
              <Button disabled={!name.trim()} size="sm" type="submit">
                <Check aria-hidden="true" />
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
