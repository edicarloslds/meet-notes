interface ImportMetaEnv {
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
  readonly MAIN_VITE_OLLAMA_HOST?: string
  readonly MAIN_VITE_OLLAMA_MODEL?: string
  readonly MAIN_VITE_WHISPER_BIN?: string
  readonly MAIN_VITE_WHISPER_MODEL?: string
  readonly MAIN_VITE_WHISPER_LANGUAGE?: string
  readonly MAIN_VITE_FFMPEG_BIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
