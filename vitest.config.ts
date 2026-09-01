import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Run every test inside the Workers runtime, against the same `staging` variables a
      // staging deploy would use.
      wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
    }),
  ],
});
