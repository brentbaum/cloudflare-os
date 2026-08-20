declare namespace Cloudflare {
  // Keep source type-checking pointed at the source module. Wrangler's generated artifact still
  // describes the deploy entrypoint under .wrangler/validate, but capnweb-validate 0.2.4 emits
  // runtime-correct validator literals there that TypeScript widens incompatibly when rechecked.
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CodexAuth";
  }
}
