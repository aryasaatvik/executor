import { useEffect, useMemo, useState } from "react";
import {
  type InstanceConfig,
  useInstanceConfig,
  useUpdateInstanceConfig,
} from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { Button } from "../components/ui/button";
import { IconSpinner } from "../components/icons";

type SemanticProvider = "" | "local" | "google" | "openai";

const defaultModelByProvider: Record<Exclude<SemanticProvider, "">, string> = {
  local: "Qwen3-Embedding-0.6B-Q8_0",
  google: "gemini-embedding-2-preview",
  openai: "text-embedding-3-small",
};

const readProvider = (
  semanticSearch: InstanceConfig["semanticSearch"],
): SemanticProvider =>
  semanticSearch?.provider === "local"
  || semanticSearch?.provider === "google"
  || semanticSearch?.provider === "openai"
    ? semanticSearch.provider
    : "";

const statusToneClass = (provider: SemanticProvider): string => {
  switch (provider) {
    case "local":
      return "bg-emerald-500/80";
    case "google":
      return "bg-sky-500/80";
    case "openai":
      return "bg-amber-500/80";
    default:
      return "bg-muted-foreground/30";
  }
};

const statusText = (
  semanticSearch: InstanceConfig["semanticSearch"],
  provider: SemanticProvider,
): string => {
  switch (provider) {
    case "local":
      return `Configured: Local (${semanticSearch?.model ?? defaultModelByProvider.local})`;
    case "google":
      return `Configured: Google (${semanticSearch?.model ?? defaultModelByProvider.google})`;
    case "openai":
      return `Configured: OpenAI (${semanticSearch?.model ?? defaultModelByProvider.openai})`;
    default:
      return "Full-text search only";
  }
};

export function SettingsPage() {
  const instanceConfig = useInstanceConfig();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Settings
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            Configure workspace settings
          </p>
        </div>

        <LoadableBlock loadable={instanceConfig} loading="Loading settings...">
          {(config) => <SemanticSearchSettingsCard config={config} />}
        </LoadableBlock>
      </div>
    </div>
  );
}

function SemanticSearchSettingsCard(props: {
  config: InstanceConfig;
}) {
  const updateConfig = useUpdateInstanceConfig();
  const initialProvider = readProvider(props.config.semanticSearch);
  const [provider, setProvider] = useState<SemanticProvider>(initialProvider);
  const [apiKey, setApiKey] = useState(props.config.semanticSearch?.apiKey ?? "");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setProvider(readProvider(props.config.semanticSearch));
    setApiKey(props.config.semanticSearch?.apiKey ?? "");
  }, [props.config.semanticSearch]);

  const cloudProvider = provider === "google" || provider === "openai";
  const trimmedApiKey = apiKey.trim();
  const dirty = useMemo(() => {
    const currentProvider = readProvider(props.config.semanticSearch);
    const currentApiKey = props.config.semanticSearch?.apiKey ?? "";
    return provider !== currentProvider || trimmedApiKey !== currentApiKey.trim();
  }, [apiKey, props.config.semanticSearch, provider, trimmedApiKey]);

  const handleSave = async () => {
    setSaveMessage(null);
    setSaveError(null);

    try {
      await updateConfig.mutateAsync({
        semanticSearch:
          provider === ""
            ? null
            : {
                provider,
                model:
                  props.config.semanticSearch?.provider === provider
                    ? props.config.semanticSearch.model
                    : defaultModelByProvider[provider],
                ...(props.config.semanticSearch?.provider === provider
                  && props.config.semanticSearch.dimensions !== undefined
                  ? { dimensions: props.config.semanticSearch.dimensions }
                  : {}),
                ...(cloudProvider && trimmedApiKey.length > 0
                  ? { apiKey: trimmedApiKey }
                  : {}),
              },
      });
      setSaveMessage("Settings saved.");
    } catch (cause) {
      setSaveError(
        cause instanceof Error ? cause.message : "Failed saving settings.",
      );
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Semantic Search</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Configure embedding providers for semantic tool discovery. When
          enabled, search understands intent &mdash; &ldquo;create
          ticket&rdquo; finds tools like{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[12px] font-mono text-foreground/80">
            github.issues.create
          </code>{" "}
          even without exact keyword matches.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card/80 divide-y divide-border">
        <div className="space-y-4 p-5">
          {saveError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive">
              {saveError}
            </div>
          )}
          {saveMessage && !saveError && (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-4 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300">
              {saveMessage}
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Provider
            </span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as SemanticProvider)}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              disabled={updateConfig.status === "pending"}
            >
              <option value="">Disabled (full-text search only)</option>
              <option value="local">Local (Qwen3-Embedding-0.6B)</option>
              <option value="google">Google (gemini-embedding-2-preview)</option>
              <option value="openai">OpenAI (text-embedding-3-small)</option>
            </select>
            <p className="text-[11px] text-muted-foreground/60">
              Local runs offline after a ~600 MB model download. Cloud
              providers require an API key.
            </p>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              API Key
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                cloudProvider
                  ? provider === "google"
                    ? "AIza..."
                    : "sk-..."
                  : "Not required for local provider"
              }
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!cloudProvider || updateConfig.status === "pending"}
            />
            <p className="text-[11px] text-muted-foreground/60">
              Optional. Leave blank to rely on environment variables such as
              GEMINI_API_KEY or OPENAI_API_KEY.
            </p>
          </label>

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={updateConfig.status === "pending" || !dirty}
            >
              {updateConfig.status === "pending"
                ? <IconSpinner className="size-3.5" />
                : null}
              Save settings
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5">
          <span className={`size-2 shrink-0 rounded-full ${statusToneClass(provider)}`} />
          <span className="text-[12px] text-muted-foreground/60">
            {statusText(props.config.semanticSearch, provider)}
          </span>
        </div>
      </div>
    </section>
  );
}
