#!/usr/bin/env python3
"""Small HTTP bridge for Distill live translation with CTranslate2 + OPUS-MT.

Example:
  python scripts/local-opus-server.py \
    --model en:pt=/path/to/opus-en-pt-ctranslate2 \
    --model pt:en=/path/to/opus-pt-en-ctranslate2

Each model directory should contain a CTranslate2 model plus source.spm and target.spm.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class ModelRegistry:
    def __init__(self, specs: list[str]) -> None:
        self.model_dirs = self._parse_specs(specs)
        self.cache: dict[tuple[str, str], tuple[Any, Any, Any]] = {}

    def translate(self, text: str, source: str, target: str) -> str:
        translator, source_spm, target_spm = self._load(source, target)
        tokens = source_spm.encode(text, out_type=str)
        result = translator.translate_batch([tokens], beam_size=1, max_decoding_length=160)
        return target_spm.decode(result[0].hypotheses[0]).strip()

    def _load(self, source: str, target: str) -> tuple[Any, Any, Any]:
        key = (source, target)
        cached = self.cache.get(key)
        if cached:
            return cached

        try:
            import ctranslate2
            import sentencepiece as spm
        except ImportError as exc:
            raise RuntimeError(
                "Instale as dependências com: pip install ctranslate2 sentencepiece"
            ) from exc

        model_dir = self.model_dirs.get(key)
        if not model_dir:
            raise RuntimeError(f"Modelo OPUS não configurado para {source}->{target}.")

        source_spm_path = model_dir / "source.spm"
        target_spm_path = model_dir / "target.spm"
        if not source_spm_path.exists() or not target_spm_path.exists():
            raise RuntimeError(
                f"{model_dir} precisa conter source.spm e target.spm junto do modelo CTranslate2."
            )

        source_spm = spm.SentencePieceProcessor()
        target_spm = spm.SentencePieceProcessor()
        source_spm.load(str(source_spm_path))
        target_spm.load(str(target_spm_path))
        translator = ctranslate2.Translator(str(model_dir), device="auto")
        loaded = (translator, source_spm, target_spm)
        self.cache[key] = loaded
        return loaded

    @staticmethod
    def _parse_specs(specs: list[str]) -> dict[tuple[str, str], Path]:
        out: dict[tuple[str, str], Path] = {}
        for spec in specs:
            pair, _, path = spec.partition("=")
            source, _, target = pair.partition(":")
            if not source or not target or not path:
                raise ValueError(f"Modelo inválido: {spec}. Use source:target=/path/to/model.")
            out[(source.strip(), target.strip())] = Path(path).expanduser().resolve()
        return out


def make_handler(registry: ModelRegistry) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self._send_json(404, {"error": "Not found"})
                return
            models = [f"{source}:{target}" for source, target in registry.model_dirs.keys()]
            self._send_json(200, {"ok": True, "models": models})

        def do_POST(self) -> None:
            if self.path != "/translate":
                self._send_json(404, {"error": "Not found"})
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(content_length)
                payload = json.loads(body.decode("utf-8"))
                text = str(payload.get("text") or payload.get("q") or "").strip()
                source = str(payload.get("source") or "").strip()
                target = str(payload.get("target") or "").strip()
                if not text or not source or not target:
                    self._send_json(400, {"error": "text, source e target são obrigatórios."})
                    return

                translated = registry.translate(text, source, target)
                self._send_json(200, {"translatedText": translated})
            except Exception as exc:  # noqa: BLE001 - HTTP boundary should serialize any failure.
                self._send_json(500, {"error": str(exc)})

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=5056, type=int)
    parser.add_argument(
        "--model",
        action="append",
        default=[],
        help="Par e caminho no formato source:target=/path/to/ctranslate2-model",
    )
    args = parser.parse_args()

    registry = ModelRegistry(args.model)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(registry))
    print(f"Distill Local OPUS listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
