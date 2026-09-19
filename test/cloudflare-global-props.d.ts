/**
 * Wrangler 4.127 no longer emits the test harness's main-module augmentation in the generated
 * worker types. Keep the Vitest Workers runtime's `cloudflare:test` exports typed explicitly.
 */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
