import { BoxIcon } from "lucide-react";
import { useState } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { getDomain } from "tldts";

// ---------------------------------------------------------------------------
// IntegrationFavicon — renders a small logo through integrations.sh.
// Falls back to a neutral icon if neither the preset nor integration yields a
// registrable domain, or if the proxy image fails to load.
// ---------------------------------------------------------------------------

const integrationFaviconDomain = (url: string | undefined): string | null => {
  if (!url) return null;
  return getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
};

// integrations.sh/logo proxies context.dev's Logo Link behind an edge cache
// and is executor's single logo source. Fallbacks (Google's favicon service,
// a letter placeholder for unknown domains) live inside the proxy, so clients
// never resolve favicons against a third party directly.
export function integrationFaviconUrl(url: string | undefined, size: number): string | null {
  const domain = integrationFaviconDomain(url);
  return integrationLogoUrl(domain ?? undefined, size);
}

export function integrationLogoUrl(domain: string | undefined, size: number): string | null {
  if (!domain || !getDomain(domain)) return null;
  return `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
}

export function integrationLocalIconUrl(integrationId: string | undefined): string | null {
  if (integrationId !== "executor") return null;
  return "/favicon-32.png";
}

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
};

const normalizeUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
};

const googleApiServiceFromUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (
      hostname === "www.googleapis.com" &&
      segments[0] === "discovery" &&
      segments[2] === "apis" &&
      segments[3]
    ) {
      return segments[3];
    }

    if (hostname === "www.googleapis.com") return segments[0] ?? null;

    const suffix = ".googleapis.com";
    if (hostname.endsWith(suffix)) {
      const service = hostname.slice(0, -suffix.length);
      return service.length > 0 ? service : null;
    }
  } catch {
    return null;
  }
  return null;
};

export function integrationInferredUrl(integration: {
  readonly id: string;
  readonly name?: string;
}): string | null {
  const hostPattern = /^[a-z0-9][a-z0-9.-]*\.(?:app|co|com|dev|io|net|org)(?:\/.*)?$/i;
  const hostLike = [integration.name, integration.id.replaceAll("_", ".")]
    .filter((value): value is string => value != null && value.length > 0)
    .find((value) => hostPattern.test(value.trim()));
  if (hostLike) return `https://${hostLike.trim().replace(/^https?:\/\//i, "")}`;

  return null;
}

// Exact identity signals only — preset defaultSlug, normalized URL equality,
// or the same Google discovery service. Fuzzy name/slug token matching used to
// live here and matched unrelated brands sharing a word fragment ("ClickHouse
// Cloud" rendered Cloudflare's logo via "cloud"). A missed match is recoverable
// (the cascade falls through to the domain-derived integrations.sh favicon,
// which is always the right brand); a wrong-brand icon is not.
export function integrationPresetLogoDomain(
  integration: {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly url?: string;
  },
  integrationPlugins: readonly IntegrationPlugin[],
): string | null {
  const pluginKey = KIND_TO_PLUGIN_KEY[integration.kind] ?? integration.kind;
  const plugin = integrationPlugins.find((p) => p.key === pluginKey);
  const presets = plugin?.presets ?? [];
  const exactSlugLogoDomain = presets.find((p) => p.defaultSlug === integration.id)?.logoDomain;
  if (exactSlugLogoDomain) return exactSlugLogoDomain;

  const integrationUrl = normalizeUrl(integration.url);
  const integrationGoogleService = googleApiServiceFromUrl(integration.url);

  const preset = presets.find((p) => {
    const presetUrl = normalizeUrl(p.url);
    const presetGoogleService = googleApiServiceFromUrl(p.url);
    return (
      (integrationUrl !== null && presetUrl === integrationUrl) ||
      (integrationGoogleService !== null && presetGoogleService === integrationGoogleService)
    );
  });

  return preset?.logoDomain ?? null;
}

// Resolution cascade: the built-in Executor mark, then the preset's canonical
// domain, then the integration URL. Every remote image is served by
// integrations.sh, so each console surface shares the same source and fallback.
export function integrationFaviconSrc(args: {
  logoDomain?: string | null;
  integrationId?: string;
  url?: string;
  size: number;
  failedSrcs?: readonly string[];
}): string | null {
  const failedSrcs = args.failedSrcs ?? [];
  return (
    [
      integrationLocalIconUrl(args.integrationId),
      integrationLogoUrl(args.logoDomain ?? undefined, args.size),
      integrationFaviconUrl(args.url, args.size),
    ].find((candidate) => candidate !== null && !failedSrcs.includes(candidate)) ?? null
  );
}

export function IntegrationFavicon({
  logoDomain,
  integrationId,
  url,
  size = 16,
}: {
  logoDomain?: string | null;
  integrationId?: string;
  url?: string;
  size?: number;
}) {
  const [failedSrcs, setFailedSrcs] = useState<readonly string[]>([]);
  const src = integrationFaviconSrc({ logoDomain, integrationId, url, size, failedSrcs });

  if (!src) {
    return (
      <BoxIcon
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() =>
        setFailedSrcs((current) => (current.includes(src) ? current : [...current, src]))
      }
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}
