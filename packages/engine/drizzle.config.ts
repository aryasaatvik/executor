import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/*.sql.ts",
  out: "./src/db/migrations",
})
