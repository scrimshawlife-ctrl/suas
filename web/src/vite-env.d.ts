/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Shown in the EnvChip (for example "Synthetic demo data"). Unset means no chip. */
  readonly VITE_SUAS_ENV_LABEL?: string;
  /** API origin when the SPA and API are on different origins. Unset means same origin. */
  readonly VITE_SUAS_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
