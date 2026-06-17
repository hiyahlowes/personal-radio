/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RADIO_MODE?: string;
  readonly VITE_RADIO_REMOTE_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
