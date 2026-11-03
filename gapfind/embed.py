"""Local text embeddings with a persistent cache.

Backends: fastembed (ONNX, default) with a sentence-transformers fallback.
The cache is a SQLite file keyed by (model name, sha256 of the text), so a
re-run with the same texts never loads the model at all.
"""

from __future__ import annotations

import hashlib
import sqlite3
import sys
from pathlib import Path

import numpy as np

DEFAULT_MODEL = "BAAI/bge-base-en-v1.5"
DEFAULT_CACHE_DIR = ".cache"

# Task prefixes some models were trained with. gapfind compares texts with
# texts (symmetric similarity), so use each card's clustering/document
# prefix on corpus AND concepts alike. The prefix is part of the cached text.
MODEL_PREFIXES = {
    "nomic-ai/nomic-embed-text-v1.5": "clustering: ",
    "nomic-ai/nomic-embed-text-v1.5-Q": "clustering: ",
    "nomic-ai/nomic-embed-text-v1": "clustering: ",
}


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EmbeddingCache:
    """(model, text hash) -> float32 vector, stored in <cache_dir>/embeddings.sqlite."""

    def __init__(self, cache_dir: str | Path):
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.dir / "embeddings.sqlite"), timeout=60)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS emb (model TEXT NOT NULL, hash TEXT NOT NULL,"
            " dim INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (model, hash))"
        )
        self.db.commit()

    def get_many(self, model: str, hashes: list[str]) -> dict[str, np.ndarray]:
        out: dict[str, np.ndarray] = {}
        for i in range(0, len(hashes), 500):  # stay under SQLite's variable limit
            part = hashes[i:i + 500]
            q = ",".join("?" * len(part))
            for h, blob in self.db.execute(
                f"SELECT hash, vec FROM emb WHERE model=? AND hash IN ({q})", [model, *part]
            ):
                out[h] = np.frombuffer(blob, dtype=np.float32)
        return out

    def put_many(self, model: str, hashes: list[str], vecs: np.ndarray) -> None:
        rows = [(model, h, int(v.shape[0]), np.asarray(v, np.float32).tobytes())
                for h, v in zip(hashes, vecs)]
        self.db.executemany("INSERT OR REPLACE INTO emb VALUES (?,?,?,?)", rows)
        self.db.commit()

    def close(self) -> None:
        self.db.close()


class _FastEmbed:
    name = "fastembed"

    def __init__(self, model: str, model_dir: Path):
        from fastembed import TextEmbedding
        self.m = TextEmbedding(model_name=model, cache_dir=str(model_dir))

    def encode(self, texts: list[str], batch_size: int) -> np.ndarray:
        return np.asarray(list(self.m.embed(texts, batch_size=batch_size)), dtype=np.float32)


class _SentenceTransformers:
    name = "sentence-transformers"

    def __init__(self, model: str, model_dir: Path):
        from sentence_transformers import SentenceTransformer
        self.m = SentenceTransformer(model, cache_folder=str(model_dir))

    def encode(self, texts: list[str], batch_size: int) -> np.ndarray:
        return np.asarray(self.m.encode(texts, batch_size=batch_size, convert_to_numpy=True,
                                        normalize_embeddings=True, show_progress_bar=False),
                          dtype=np.float32)


def load_backend(model: str, backend: str, model_dir: Path):
    """backend: auto | fastembed | sentence-transformers. `auto` tries
    fastembed first and falls back to sentence-transformers if installed."""
    order = {"auto": ["fastembed", "sentence-transformers"],
             "fastembed": ["fastembed"],
             "sentence-transformers": ["sentence-transformers"]}[backend]
    errors = []
    for name in order:
        try:
            cls = _FastEmbed if name == "fastembed" else _SentenceTransformers
            return cls(model, model_dir)
        except Exception as e:  # any load failure triggers the fallback
            errors.append(f"{name}: {type(e).__name__}: {e}")
            print(f"[gapfind] backend {name} failed ({type(e).__name__}: {e})", file=sys.stderr)
    raise RuntimeError(f"could not load an embedding backend for {model!r}:\n  "
                       + "\n  ".join(errors))


def embed_texts(texts: list[str], *, model: str = DEFAULT_MODEL, backend: str = "auto",
                cache_dir: str | Path = DEFAULT_CACHE_DIR, model_dir: str | Path | None = None,
                batch_size: int = 64, verbose: bool = True) -> tuple[np.ndarray, dict]:
    """Embed `texts`; returns (L2-normalized float32 array (n, dim), stats).
    The model is loaded only if at least one text is not in the cache.
    Embeddings are cached in `cache_dir`; model weights in `model_dir`
    (default <cache_dir>/models)."""
    cache_dir = Path(cache_dir)
    model_dir = Path(model_dir) if model_dir else cache_dir / "models"
    prefix = MODEL_PREFIXES.get(model, "")
    if prefix:
        texts = [prefix + t for t in texts]
    hashes = [text_hash(t) for t in texts]
    uniq = list(dict.fromkeys(hashes))
    first_text: dict[str, str] = {}
    for h, t in zip(hashes, texts):
        first_text.setdefault(h, t)

    cache = EmbeddingCache(cache_dir)
    try:
        have = cache.get_many(model, uniq)
        todo = [h for h in uniq if h not in have]
        stats = {"texts": len(texts), "unique": len(uniq),
                 "cache_hits": len(uniq) - len(todo), "cache_misses": len(todo),
                 "backend": None}
        if todo:
            be = load_backend(model, backend, model_dir)
            stats["backend"] = be.name
            for i in range(0, len(todo), 1024):
                part = todo[i:i + 1024]
                vecs = be.encode([first_text[h] for h in part], batch_size)
                vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
                cache.put_many(model, part, vecs)
                for h, v in zip(part, vecs):
                    have[h] = v.astype(np.float32)
                if verbose:
                    print(f"[gapfind] embedded {min(i + 1024, len(todo))}/{len(todo)} new texts",
                          file=sys.stderr, flush=True)
    finally:
        cache.close()

    emb = np.stack([have[h] for h in hashes]).astype(np.float32)
    emb /= np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-12)
    return emb, stats
