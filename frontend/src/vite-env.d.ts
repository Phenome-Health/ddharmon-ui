/// <reference types="vite/client" />

/** The git tree this bundle was built from (`lib/build-stamp.ts`), injected by `vite.config.ts`; null outside git. */
declare const __UI_TREE__: string | null;

interface ImportMetaEnv {
  /** Comma-separated content pages this build leaves out (`lib/hidden-pages.ts`); prod sets it, other builds don't. */
  readonly VITE_HIDDEN_PAGES?: string;
}
