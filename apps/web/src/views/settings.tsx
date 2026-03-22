import { useEffect, useMemo, useState } from "react";
import {
  type InstanceConfig,
  useInstanceConfig,
  useUpdateInstanceConfig,
} from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { Button } from "../components/ui/button";
import { IconSpinner } from "../components/icons";

type SemanticProvider =
  | ""
  | "local"
  | "google"
  | "openai";

type ConfiguredSemanticProvider = Exclude<SemanticProvider, "">;

type SemanticFormState = {
  provider: SemanticProvider;
  model: string;
  dimensions: string;
  apiKey: string;
};

const semanticProviders: ReadonlyArray<ConfiguredSemanticProvider> = [
  "local",
  "google",
  "openai",
];

const providerLabel: Record<ConfiguredSemanticProvider, string> = {
  local: "Local",
  google: "Google",
  openai: "OpenAI",
};

const defaultModelByProvider: Record<ConfiguredSemanticProvider, string> = {
  local: "Qwen3-Embedding-0.6B-Q8_0",
  google: "gemini-embedding-2-preview",
  openai: "text-embedding-3-small",
};

const defaultDimensionsByProvider: Record<ConfiguredSemanticProvider, number> = {
  local: 1024,
  google: 3072,
  openai: 1536,
};

const apiKeyPlaceholderByProvider: Partial<Record<ConfiguredSemanticProvider, string>> = {
  google: "AIza...",
  openai: "sk-...",
};

const isConfiguredProvider = (
  provider: string | null | undefined,
): provider is ConfiguredSemanticProvider =>
  semanticProviders.includes(provider as ConfiguredSemanticProvider);

const defaultModelForProvider = (provider: ConfiguredSemanticProvider): string =>
  defaultModelByProvider[provider];

const defaultDimensionsForProvider = (
  provider: ConfiguredSemanticProvider,
): number => defaultDimensionsByProvider[provider];

const buildSemanticFormState = (
  semanticSearch: InstanceConfig["semanticSearch"],
): SemanticFormState => {
  if (!semanticSearch || !isConfiguredProvider(semanticSearch.provider)) {
    return {
      provider: "",
      model: "",
      dimensions: "",
      apiKey: "",
    };
  }

  return {
    provider: semanticSearch.provider,
    model: semanticSearch.model ?? defaultModelForProvider(semanticSearch.provider),
    dimensions: String(
      semanticSearch.dimensions ?? defaultDimensionsForProvider(semanticSearch.provider),
    ),
    apiKey:
      semanticSearch.provider === "local"
        ? ""
        : semanticSearch.apiKey ?? "",
  };
};

const buildCanonicalSemanticSearch = (
  form: SemanticFormState,
): InstanceConfig["semanticSearch"] => {
  if (form.provider === "") {
    return null;
  }

  const provider = form.provider;
  const normalizedModel = form.model.trim() || defaultModelForProvider(provider);
  const parsedDimensions = Number.parseInt(form.dimensions.trim(), 10);
  const normalizedDimensions = Number.isFinite(parsedDimensions) && parsedDimensions > 0
    ? parsedDimensions
    : defaultDimensionsForProvider(provider);
  const trimmedApiKey = form.apiKey.trim();

  return {
    provider,
    model: normalizedModel,
    dimensions: normalizedDimensions,
    ...(provider !== "local" && trimmedApiKey.length > 0
      ? { apiKey: trimmedApiKey }
      : {}),
  };
};

const semanticSearchFingerprint = (
  semanticSearch: InstanceConfig["semanticSearch"],
): string => JSON.stringify(semanticSearch ?? null);

const statusToneClass = (
  provider: SemanticProvider,
  unsupportedConfig: InstanceConfig["semanticSearch"],
): string => {
  if (unsupportedConfig) {
    return "bg-destructive/80";
  }

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
  form: SemanticFormState,
  unsupportedConfig: InstanceConfig["semanticSearch"],
): string => {
  if (unsupportedConfig) {
    return `Unsupported semantic-search config (${unsupportedConfig.provider})`;
  }

  if (form.provider === "") {
    return "Full-text search only";
  }

  return `Configured: ${providerLabel[form.provider]} (${form.model.trim() || defaultModelForProvider(form.provider)})`;
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
  const unsupportedConfig = useMemo(
    () =>
      props.config.semanticSearch && !isConfiguredProvider(props.config.semanticSearch.provider)
        ? props.config.semanticSearch
        : null,
    [props.config.semanticSearch],
  );
  const [form, setForm] = useState<SemanticFormState>(() =>
    buildSemanticFormState(props.config.semanticSearch),
  );
  const [hasEdited, setHasEdited] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setForm(buildSemanticFormState(props.config.semanticSearch));
    setHasEdited(false);
    setSaveMessage(null);
    setSaveError(null);
  }, [props.config.semanticSearch]);

  const cloudProvider = form.provider !== "" && form.provider !== "local";
  const nextSemanticSearch = useMemo(
    () => buildCanonicalSemanticSearch(form),
    [form],
  );
  const dirty = useMemo(() => {
    if (unsupportedConfig && !hasEdited) {
      return false;
    }

    return semanticSearchFingerprint(nextSemanticSearch)
      !== semanticSearchFingerprint(props.config.semanticSearch);
  }, [hasEdited, nextSemanticSearch, props.config.semanticSearch, unsupportedConfig]);

  const handleSave = async () => {
    setSaveMessage(null);
    setSaveError(null);

    try {
      await updateConfig.mutateAsync({
        semanticSearch: nextSemanticSearch,
      });
      setSaveMessage("Settings saved.");
    } catch (cause) {
      setSaveError(
        cause instanceof Error ? cause.message : "Failed saving settings.",
      );
    }
  };

  const updateForm = (next: Partial<SemanticFormState>) => {
    setHasEdited(true);
    setSaveMessage(null);
    setSaveError(null);
    setForm((current) => ({
      ...current,
      ...next,
    }));
  };

  const handleProviderChange = (nextProvider: SemanticProvider) => {
    if (nextProvider === "") {
      updateForm({
        provider: "",
        model: "",
        dimensions: "",
        apiKey: "",
      });
      return;
    }

    updateForm({
      provider: nextProvider,
      model: defaultModelForProvider(nextProvider),
      dimensions: String(defaultDimensionsForProvider(nextProvider)),
      apiKey: "",
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Semantic Search</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Configure embedding providers for semantic tool discovery. The UI now
          writes a canonical semantic-search block, so changing providers will
          replace stale provider-specific fields instead of preserving them.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card/80 divide-y divide-border">
        <div className="space-y-4 p-5">
          {unsupportedConfig && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200">
              <div className="font-medium">
                Unsupported semantic-search config loaded from the workspace.
              </div>
              <p className="mt-1 text-[12px] text-amber-700/90 dark:text-amber-200/80">
                This UI cannot represent provider <code className="rounded bg-black/5 px-1 py-0.5 dark:bg-white/10">{unsupportedConfig.provider}</code> directly.
                Choose a supported provider below or disable semantic search to replace it.
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-black/5 p-3 text-[11px] text-amber-900/90 dark:bg-white/10 dark:text-amber-100/90">
                {JSON.stringify(unsupportedConfig, null, 2)}
              </pre>
            </div>
          )}

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
              value={form.provider}
              onChange={(event) =>
                handleProviderChange(event.target.value as SemanticProvider)}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              disabled={updateConfig.status === "pending"}
            >
              <option value="">Disabled (full-text search only)</option>
              <option value="local">Local</option>
              <option value="google">Google</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Model
            </span>
            <input
              type="text"
              value={form.model}
              onChange={(event) => updateForm({ model: event.target.value })}
              placeholder={
                form.provider === ""
                  ? "Select a provider first"
                  : defaultModelForProvider(form.provider)
              }
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={form.provider === "" || updateConfig.status === "pending"}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Dimensions
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={form.dimensions}
              onChange={(event) => updateForm({ dimensions: event.target.value })}
              placeholder={
                form.provider === ""
                  ? "Select a provider first"
                  : String(defaultDimensionsForProvider(form.provider))
              }
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={form.provider === "" || updateConfig.status === "pending"}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              API Key
            </span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => updateForm({ apiKey: event.target.value })}
              placeholder={
                cloudProvider
                  ? apiKeyPlaceholderByProvider[form.provider as ConfiguredSemanticProvider] ?? "API key"
                  : "Not required for local provider"
              }
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!cloudProvider || updateConfig.status === "pending"}
            />
            <p className="text-[11px] text-muted-foreground/60">
              Leave blank to rely on environment variables such as
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
          <span
            className={`size-2 shrink-0 rounded-full ${statusToneClass(form.provider, unsupportedConfig)}`}
          />
          <span className="text-[12px] text-muted-foreground/60">
            {statusText(form, unsupportedConfig)}
          </span>
        </div>
      </div>
    </section>
  );
}
