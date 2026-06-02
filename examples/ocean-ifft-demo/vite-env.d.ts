/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string
  readonly STORYBOOK_ION_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

