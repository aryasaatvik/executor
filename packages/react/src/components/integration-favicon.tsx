import { BoxIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { getDomain } from "tldts";

import { EXECUTOR_ICON_SCHEME, resolveExecutorIcon } from "./preset-icon";

const awsDocsIcon = new URL("../assets/integration-logos/aws-docs.svg", import.meta.url).href;
const codeGrepIcon = new URL("../assets/integration-logos/code-grep.svg", import.meta.url).href;
const exaSearchApiIcon = new URL("../assets/integration-logos/exa-search-api.svg", import.meta.url)
  .href;
const googleCalendarIcon = new URL(
  "../assets/integration-logos/google-calendar.svg",
  import.meta.url,
).href;
const googleDocsIcon = new URL("../assets/integration-logos/google-docs.svg", import.meta.url).href;
const googleDriveIcon = new URL("../assets/integration-logos/google-drive.svg", import.meta.url)
  .href;
const googleFormsIcon = new URL("../assets/integration-logos/google-forms.svg", import.meta.url)
  .href;
const googleGmailIcon = new URL("../assets/integration-logos/google-gmail.svg", import.meta.url)
  .href;
const googleSearchConsoleIcon = new URL(
  "../assets/integration-logos/google-search-console.svg",
  import.meta.url,
).href;
const googleSheetsIcon = new URL("../assets/integration-logos/google-sheets.svg", import.meta.url)
  .href;
const googleSlidesIcon = new URL("../assets/integration-logos/google-slides.svg", import.meta.url)
  .href;
const googleYouTubeDataIcon = new URL(
  "../assets/integration-logos/google-youtube-data.svg",
  import.meta.url,
).href;
const openAiDocsIcon = new URL("../assets/integration-logos/openai-docs.svg", import.meta.url).href;

// ---------------------------------------------------------------------------
// IntegrationFavicon — renders a small favicon derived from an integration URL.
// Falls back to a neutral icon if the URL is missing or the image fails to load.
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
  if (!domain) return null;
  return `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
}

const LOCAL_INTEGRATION_ICON_URLS: Readonly<Record<string, string>> = {
  executor: "/favicon-32.png",
  aws_docs: awsDocsIcon,
  code_grep: codeGrepIcon,
  exa_search_api: exaSearchApiIcon,
  google_calendar: googleCalendarIcon,
  google_docs: googleDocsIcon,
  google_drive: googleDriveIcon,
  google_forms: googleFormsIcon,
  google_gmail: googleGmailIcon,
  google_search_console: googleSearchConsoleIcon,
  google_sheets: googleSheetsIcon,
  google_slides: googleSlidesIcon,
  google_youtube_data: googleYouTubeDataIcon,
  openai_docs: openAiDocsIcon,
};

export function integrationLocalIconUrl(integrationId: string | undefined): string | null {
  return integrationId ? (LOCAL_INTEGRATION_ICON_URLS[integrationId] ?? null) : null;
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
export function integrationPresetIconUrl(
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
  const exactSlugIcon = presets.find((p) => p.defaultSlug === integration.id)?.icon;
  if (exactSlugIcon) return exactSlugIcon;

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

  return preset?.icon ?? null;
}

// Resolution cascade for the rendered favicon: first non-null, non-failed of the
// bundled local icon for a known integration id, an explicit preset icon, then
// the integrations.sh logo proxy derived from the integration URL. Local assets
// intentionally override unsuitable remote variants and preserve distinct Google
// service marks. Unknown integrations still use upstream's preset and URL paths.
export function integrationFaviconSrc(args: {
  icon?: string | null;
  integrationId?: string;
  url?: string;
  size: number;
  failedSrcs?: readonly string[];
}): string | null {
  const failedSrcs = args.failedSrcs ?? [];
  return (
    [
      integrationLocalIconUrl(args.integrationId),
      args.icon ?? null,
      integrationFaviconUrl(args.url, args.size),
    ].find((candidate) => candidate !== null && !failedSrcs.includes(candidate)) ?? null
  );
}

export function IntegrationFavicon({
  icon,
  integrationId,
  url,
  size = 16,
}: {
  icon?: string | null;
  integrationId?: string;
  url?: string;
  size?: number;
}) {
  const [failedSrcs, setFailedSrcs] = useState<readonly string[]>([]);
  // `executor:`-scheme icons (served by the local API behind the bearer gate,
  // e.g. a Codex plugin's own icon) resolve asynchronously to a data URI; a
  // null resolution marks the candidate failed so the cascade continues.
  const [executorIcons, setExecutorIcons] = useState<Readonly<Record<string, string>>>({});
  const cascadeSrc = integrationFaviconSrc({ icon, integrationId, url, size, failedSrcs });
  const isExecutorSrc = cascadeSrc?.startsWith(EXECUTOR_ICON_SCHEME) ?? false;

  useEffect(() => {
    if (!isExecutorSrc || cascadeSrc === null) return;
    let live = true;
    void resolveExecutorIcon(cascadeSrc.slice(EXECUTOR_ICON_SCHEME.length)).then((resolvedIcon) => {
      if (!live) return;
      if (resolvedIcon === null) {
        setFailedSrcs((current) =>
          current.includes(cascadeSrc) ? current : [...current, cascadeSrc],
        );
      } else {
        setExecutorIcons((current) => ({ ...current, [cascadeSrc]: resolvedIcon }));
      }
    });
    return () => {
      live = false;
    };
  }, [isExecutorSrc, cascadeSrc]);

  const src =
    cascadeSrc === null ? null : isExecutorSrc ? (executorIcons[cascadeSrc] ?? null) : cascadeSrc;

  if (!src) {
    return (
      <BoxIcon
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  // On error, fail the CASCADE candidate (the `executor:` string for resolved
  // icons), not the rendered data URI, so the cascade actually advances.
  const failedCandidate = cascadeSrc ?? src;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() =>
        setFailedSrcs((current) =>
          current.includes(failedCandidate) ? current : [...current, failedCandidate],
        )
      }
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}
