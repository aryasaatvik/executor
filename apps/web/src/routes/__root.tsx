import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import * as React from "react";
import { ExecutorReactProvider } from "@executor/react";
import { AppShell } from "../components/shell";
import globalsCss from "../globals.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { name: "color-scheme", content: "light dark" },
      { title: "Executor" },
      {
        name: "description",
        content:
          "Executor — manage sources, inspect tools, and monitor executions.",
      },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <React.StrictMode>
        <ExecutorReactProvider>
          <AppShell />
        </ExecutorReactProvider>
      </React.StrictMode>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
