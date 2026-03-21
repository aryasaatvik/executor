// ---------------------------------------------------------------------------
// Settings page — embedding configuration (UI placeholder)
// ---------------------------------------------------------------------------

export function SettingsPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Settings
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            Configure workspace settings
          </p>
        </div>

        {/* Embedding Configuration Section */}
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

          <div className="rounded-xl border border-border bg-card/80 divide-y divide-border overflow-hidden">
            <div className="p-5 space-y-4">
              {/* Provider selector */}
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Provider
                </span>
                <select className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25">
                  <option value="">Disabled (full-text search only)</option>
                  <option value="local">Local (Qwen3-Embedding-0.6B)</option>
                  <option value="google">
                    Google (gemini-embedding-2-preview)
                  </option>
                  <option value="openai">
                    OpenAI (text-embedding-3-small)
                  </option>
                </select>
                <p className="text-[11px] text-muted-foreground/60">
                  Local runs offline after a ~600 MB model download. Cloud
                  providers require an API key.
                </p>
              </label>

              {/* API Key field */}
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  API Key
                </span>
                <input
                  type="password"
                  placeholder="Not required for local provider"
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                  disabled
                />
                <p className="text-[11px] text-muted-foreground/60">
                  Or set via environment variable (GEMINI_API_KEY,
                  OPENAI_API_KEY, etc.)
                </p>
              </label>
            </div>

            {/* Status indicator */}
            <div className="flex items-center gap-2 px-5 py-3.5">
              <span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" />
              <span className="text-[12px] text-muted-foreground/60">
                Not configured
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
