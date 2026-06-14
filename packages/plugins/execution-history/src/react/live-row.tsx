export function LiveDivider() {
  return (
    <div className="relative flex items-center py-1">
      <div className="flex-1 border-t border-border" />
      <span className="mx-3 flex items-center gap-1.5 text-[11px] text-muted-foreground select-none">
        <span className="relative flex size-1.5 shrink-0">
          <span className="absolute inline-flex size-full animate-pulse rounded-full bg-emerald-500 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        Live
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}
