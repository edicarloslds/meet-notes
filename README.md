# MeetNotes

Desktop app (macOS) que detecta reuniões do Microsoft Teams, grava o áudio, transcreve com Whisper, resume com GPT-4o e persiste no Supabase — com fallback offline.

## Stack

- **Electron 41** + **electron-vite 5** (Main em TypeScript, Vite 7)
- **React 19** + **TypeScript 5.9** + **Tailwind CSS 4** (via `@tailwindcss/vite`)
- **Supabase** (Postgres + Auth) — `@supabase/supabase-js` 2.103
- **OpenAI** 6.x (Whisper + GPT-4o, JSON mode)
- `get-windows` 9 (detecção de janela, sucessor do `active-win`), `electron-store` 11 (offline)

## Setup

Requer **pnpm ≥ 10** e Node ≥ 20.

```bash
cp .env.example .env       # preencha suas chaves
pnpm install
pnpm approve-builds        # permite o postinstall nativo do get-windows
pnpm dev
```

### Scripts

| comando              | descrição                                   |
| -------------------- | ------------------------------------------- |
| `pnpm dev`           | Dev server (renderer) + Electron em watch   |
| `pnpm build`         | Build do main, preload e renderer (`out/`)  |
| `pnpm typecheck`     | Verifica tsconfig.node + tsconfig.web       |
| `pnpm package`       | Empacota `.dmg` via electron-builder (mac)  |

### Variáveis de ambiente (`.env`)

```
MAIN_VITE_OPENAI_API_KEY=sk-...
MAIN_VITE_SUPABASE_URL=https://xxx.supabase.co
MAIN_VITE_SUPABASE_ANON_KEY=eyJ...
```

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
    aiService.ts        # Whisper + GPT-4o (JSON mode)
    storageService.ts   # Supabase + electron-store (fila offline)
  preload/
    index.ts            # contextBridge → window.meetnotes
  renderer/
    pill.html           # BrowserWindow da pílula flutuante
    dashboard.html      # BrowserWindow principal
    src/
      pill/Pill.tsx
      dashboard/Dashboard.tsx
      hooks/useAudioRecorder.ts   # desktopCapturer + MediaRecorder
      styles.css                  # @import "tailwindcss"; @theme { ... }
  shared/types.ts       # Tipos + canais IPC compartilhados
```

### Fluxo

1. `meetingWatcher` faz poll a cada 3s com `get-windows`. Se o owner é Teams e o título contém "Reunião"/"Meeting", dispara `meeting:detected`.
2. O Main cria um `BrowserWindow` pílula (frameless, transparente, `alwaysOnTop`).
3. Usuário clica **Gravar** → `useAudioRecorder` usa `chromeMediaSource: 'desktop'` (loopback) com fallback para microfone.
4. Ao clicar **Parar**: estado vai para `transcribing` (loader *"IA gerando resumo…"*), o Main chama Whisper + GPT-4o e retorna `{ transcript, summary, action_items }`.
5. Estado `saving`: grava em `electron-store` (sempre) e faz upsert no Supabase. Se falhar, entra em fila `pending`.
6. Ao voltar online, `syncPendingMeetings` reenvia. O Dashboard escuta `window.online` para disparar o sync automaticamente.

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
- **Gravação de Tela** (para `desktopCapturer` capturar áudio do sistema)
- **Microfone** (fallback)
- **Acessibilidade / Automation** (para `get-windows` ler o título da janela ativa)

## Notas técnicas

- `electron-store` 11 e `get-windows` 9 são ESM-only; o código do main usa `await import(...)` dinâmico para carregá-los dentro do bundle CJS do processo Main.
- `@vitejs/plugin-react` está em **5.2** (não 6.0) para alinhar com o peer `vite ^7` exigido pelo `electron-vite 5`.
- Tipos do preload retornam `(): void` explicitamente — caso contrário o `ipcRenderer.removeListener` vaza um retorno `IpcRenderer` que quebra o `EffectCallback` do React.

## Limitações do MVP

- Auth Supabase não integrado na UI — `user_id` é `null` por padrão (RLS permite).
- `desktopCapturer` no macOS captura áudio apenas com permissão de gravação de tela; ambientes corporativos podem bloquear. Use o fallback de microfone quando necessário.
- Transcrição é single-shot ao parar a gravação (não em chunks durante a reunião). Chunking em tempo real seria a próxima evolução.
