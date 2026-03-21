import { useMemo, useState } from "react";
import type { Source } from "@executor/react";
import { getGoogleProductIconUrl, getSourceFaviconUrl } from "../lib/source-favicon";
import { cn } from "../lib/utils";

type SourceKind = Source["kind"] | string;

export function SourceFavicon({
  endpoint,
  kind,
  iconUrl,
  className,
  size = 16,
}: {
  endpoint?: string | null;
  kind: SourceKind;
  iconUrl?: string | null;
  className?: string;
  size?: number;
}) {
  const faviconUrl = useMemo(() => {
    if (iconUrl) return iconUrl; // manual override takes priority
    // For google_discovery, prefer the real product icon
    if (kind === "google_discovery") {
      return getGoogleProductIconUrl(endpoint) ?? getSourceFaviconUrl(endpoint);
    }
    return getSourceFaviconUrl(endpoint);
  }, [iconUrl, endpoint, kind]);

  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isFailed = Boolean(faviconUrl && failedUrl === faviconUrl);

  if (!faviconUrl || isFailed) {
    return <DefaultSourceIcon kind={kind} className={className} />;
  }

  return (
    <img
      key={faviconUrl}
      src={faviconUrl}
      alt=""
      width={size}
      height={size}
      className={cn("size-full object-contain", className)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

export function DefaultSourceIcon({
  kind,
  className,
}: {
  kind: SourceKind;
  className?: string;
}) {
  const base = cn("shrink-0", className);

  switch (kind) {
    case "mcp":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 7h1M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "graphql":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <path d="M8 2L14 5.5V10.5L8 14L2 10.5V5.5L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" opacity="0.5" />
        </svg>
      );
    case "openapi":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 6h6M5 8h4M5 10h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "google_discovery":
      return (
        <svg viewBox="0 0 16 16" className={base}>
          <path d="M8 3.2a4.8 4.8 0 00-3.39 8.2l1.02-1.02A3.36 3.36 0 018 4.64a3.33 3.33 0 012.34.96l1.03-1.03A4.78 4.78 0 008 3.2z" fill="#EA4335" />
          <path d="M12.8 8c0-.37-.04-.72-.1-1.06H8v2.12h2.7a2.4 2.4 0 01-1 1.52l1.02 1.02A4.8 4.8 0 0012.8 8z" fill="#4285F4" />
          <path d="M5.63 9.38A3.36 3.36 0 014.64 8c0-.5.11-.97.3-1.4L3.92 5.58A4.78 4.78 0 003.2 8c0 .88.26 1.7.72 2.4l1.02-1.02z" fill="#FBBC05" />
          <path d="M8 12.8c1.2 0 2.27-.4 3.1-1.1l-1.02-1.02c-.54.38-1.24.6-2.08.6a3.36 3.36 0 01-3.07-2.28l-1.02 1.02A4.8 4.8 0 008 12.8z" fill="#34A853" />
        </svg>
      );
    case "internal":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <path d="M8 2v12M4 6l4-4 4 4M4 10l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 6h6M5 8h4M5 10h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
  }
}
