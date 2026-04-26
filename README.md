# Distill

Desktop app (macOS) que detecta reuniões, grava o áudio, transcreve localmente com whisper.cpp, oferece uma visão separada de transcrição/tradução ao vivo com Apple Speech e persiste no Supabase — com fallback offline.

## Stack

- **Electron 41** + **electron-vite 5** (Main em TypeScript, Vite 7)
- **React 19** + **TypeScript 5.9** + **Tailwind CSS 4** (via `@tailwindcss/vite`)
- **Supabase** (Postgres + Auth) — `@supabase/supabase-js` 2.103
- **whisper.cpp** (transcrição local via binário `whisper-cli`) + **ffmpeg** (conversão webm→wav)
- **Apple Speech** (transcrição ao vivo opcional via helper nativo Swift)
- **LibreTranslate / Local OPUS** (tradução ao vivo dedicada para legendas)
- **Ollama** (resumo local, JSON mode)
- `get-windows` 9 (detecção de janela, sucessor do `active-win`), `electron-store` 11 (offline)

## Setup

Requer **pnpm ≥ 10** e Node ≥ 20.

Dependências externas (macOS):

```bash
brew install whisper-cpp ollama
ollama pull gemma4:e2b
```

Para tradução ao vivo local via LibreTranslate:

```bash
pipx install libretranslate
libretranslate --host 127.0.0.1 --port 5000
```

Também é possível apontar a configuração **Tradução ao vivo → Provider** para `Local OPUS`. O repositório inclui um bridge HTTP simples para CTranslate2/OPUS-MT:

```bash
pip install ctranslate2 sentencepiece
python scripts/local-opus-server.py \
  --model en:pt=/path/to/opus-en-pt-ctranslate2 \
  --model pt:en=/path/to/opus-pt-en-ctranslate2
```

Cada diretório de modelo deve conter o modelo CTranslate2 e os arquivos `source.spm` e `target.spm`.

O `ffmpeg` já vem embutido (`ffmpeg-static`). O modelo do whisper.cpp é baixado direto pelo app em **Configurações → Modelos do Whisper**.

```bash
cp .env.example .env       # preencha as variáveis
pnpm install
pnpm approve-builds        # permite o postinstall nativo do get-windows
pnpm dev
```

### Scripts

| comando              | descrição                                   |
| -------------------- | ------------------------------------------- |
| `pnpm dev`           | Dev server (renderer) + Electron em watch   |
| `pnpm build:apple-speech` | Compila o helper nativo do Apple Speech |
| `pnpm build`         | Build do helper, main, preload e renderer (`out/`) |
| `pnpm typecheck`     | Verifica tsconfig.node + tsconfig.web       |
| `pnpm package`       | Empacota `.dmg` via electron-builder (mac)  |

### Variáveis de ambiente (`.env`)

```
MAIN_VITE_SUPABASE_URL=https://xxx.supabase.co
MAIN_VITE_SUPABASE_ANON_KEY=eyJ...
```

As demais opções (captura de áudio, host/modelo do Ollama, idioma do Whisper, provider de tradução ao vivo etc.) são configuradas em **Configurações** dentro do app. A janela **Transcrição ao vivo** tem controles próprios para idioma de origem, idioma de tradução, provider de tradução e fonte de áudio.

O prefixo `MAIN_VITE_` é injetado pelo electron-vite no processo **Main** (nunca exposto no renderer).

### Schema do Supabase

```sql
create table public.meetings (
  id uuid primary key,
  user_id uuid references auth.users(id),
  title text not null,
  raw_transcript text,
  summary text,
  action_items jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.meetings enable row level security;

create policy "users manage their meetings"
  on public.meetings for all
  using (auth.uid() = user_id or user_id is null)
  with check (auth.uid() = user_id or user_id is null);
```

## Arquitetura

```
src/
  main/                 # Processo Main (Node/Electron)
    index.ts            # Bootstrap, BrowserWindows, IPC handlers
    meetingWatcher.ts   # Poll via get-windows (Teams + "Reunião"/"Meeting")
    aiService.ts        # whisper.cpp (ffmpeg + whisper-cli) + Ollama para resumo (JSON mode)
    liveTranslationService.ts # Tradução ao vivo via LibreTranslate ou Local OPUS
    storageService.ts   # Supabase + electron-store (fila offline)
  preload/
    index.ts            # contextBridge → window.distill
  renderer/
    pill.html           # BrowserWindow da pílula flutuante
    live.html           # BrowserWindow de transcrição ao vivo
    dashboard.html      # BrowserWindow principal
    src/
      pill/Pill.tsx
      live/LiveTranscript.tsx
      dashboard/Dashboard.tsx
      hooks/useAudioRecorder.ts   # getDisplayMedia/getUserMedia + AudioWorklet (PCM + frames ao vivo)
      styles.css                  # @import "tailwindcss"; @theme { ... }
  shared/types.ts       # Tipos + canais IPC compartilhados
```

### Fluxo

1. `meetingWatcher` faz poll a cada 3s com `get-windows`. Quando identifica uma janela de reunião compatível, dispara `meeting:detected`.
2. O Main cria um `BrowserWindow` pílula (frameless, transparente, `alwaysOnTop`).
3. Usuário clica **Gravar** → `useAudioRecorder` tenta capturar áudio do sistema via `getDisplayMedia`, com modos configuráveis para sistema, microfone ou misto e fallback explícito para microfone no modo automático.
4. Durante a gravação da pílula, o Main transcreve chunks de 30s com `whisper-cli`.
5. A janela **Transcrição ao vivo** é uma feature separada: ela captura áudio, transcreve com Apple Speech, permite escolher idioma de origem e traduz as legendas via um provider dedicado (`LibreTranslate` ou `Local OPUS`). O Ollama não é usado nessa etapa.
6. Ao clicar **Parar** na pílula: o Main finaliza a transcrição, normaliza os segmentos e, se o Ollama estiver disponível, gera o resumo. Se o Ollama estiver offline, a transcrição ainda é salva normalmente.
7. Estado `saving`: grava em `electron-store` (sempre) e faz upsert no Supabase. Se falhar, entra em fila `pending`.
8. Ao voltar online, `syncPendingMeetings` reenvia. O Dashboard escuta `window.online` para disparar o sync automaticamente.

### Pílula — estados

| estado         | visual                                         |
| -------------- | ---------------------------------------------- |
| `idle`         | dot azul + botão "Gravar"                      |
| `recording`    | dot vermelho pulsante + timer + botão "Parar"  |
| `transcribing` | dot âmbar + spinner + "IA gerando resumo…"     |
| `saving`       | dot verde + spinner + "Salvando…"              |

## Tailwind v4

Este projeto usa a nova sintaxe do Tailwind 4 — sem `tailwind.config.js` nem PostCSS:

- `@tailwindcss/vite` registrado em `electron.vite.config.ts`
- `src/renderer/src/styles.css` começa com `@import "tailwindcss";`
- Animações e tokens customizados ficam em `@theme { ... }`

## Build

```bash
pnpm build            # empacota Main/Preload/Renderer em out/
pnpm package          # electron-builder (macOS .dmg)
```

## Permissões macOS

Na primeira execução o macOS pedirá:
- **Gravação de Tela** (para detectar reuniões e tentar capturar áudio do sistema)
- **Microfone** (modo dedicado e fallback)
- **Reconhecimento de Fala** (modo Apple Speech ao vivo)
- **Acessibilidade / Automation** (para `get-windows` ler o título da janela ativa)

## Notas técnicas

- `electron-store` 11 e `get-windows` 9 são ESM-only; o código do main usa `await import(...)` dinâmico para carregá-los dentro do bundle CJS do processo Main.
- `@vitejs/plugin-react` está em **5.2** (não 6.0) para alinhar com o peer `vite ^7` exigido pelo `electron-vite 5`.
- Tipos do preload retornam `(): void` explicitamente — caso contrário o `ipcRenderer.removeListener` vaza um retorno `IpcRenderer` que quebra o `EffectCallback` do React.

## Limitações do MVP

- Auth Supabase não integrado na UI — `user_id` é `null` por padrão (RLS permite).
- A disponibilidade de áudio do sistema depende do seletor de captura do macOS e pode variar por app, janela ou política corporativa. O modo automático cai para microfone quando necessário.
- A transcrição já é feita em chunks locais, mas ainda sem stitching avançado entre janelas; a próxima evolução é reconciliar overlap e melhorar o contexto entre segmentos.
