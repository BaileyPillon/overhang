r"""Place extra texts on the Overhang globe with the LIVE recipe in runs/r2/globe/live_index.json.

  .venv\Scripts\python.exe -I scripts\place_on_globe.py            # writes app/public/data/overlays.json
  .venv\Scripts\python.exe -I scripts\place_on_globe.py --selftest  # only run the selftest

Recipe: bge-small-en-v1.5 (CLS, normalized, fastembed, cache .cache/models) -> subtract corpus mean,
renormalize -> 8 nearest by cosine against the dequantized int8 index -> w = max(cos - cos_8th + 0.02, 1e-9)
-> position = normalize(sum w*xyz). R = resultant length |sum w*xyz| / sum w. Facet guess: neighbour majority vote.
"""
import json, math, shutil, sys
from collections import Counter
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GL = ROOT / "runs" / "r2" / "globe"
DATA = ROOT / "app" / "public" / "data"
K = 8


class Placer:
    def __init__(self):
        self.idx = json.load(open(GL / "live_index.json", encoding="utf-8"))
        n, dims = self.idx["n"], self.idx["dims"]
        q = np.fromfile(GL / self.idx["file"], dtype=np.int8).reshape(n, dims).astype(np.float32)
        x = q * np.array(self.idx["scale"], dtype=np.float32)
        self.X = x / np.linalg.norm(x, axis=1, keepdims=True)
        self.mean = np.array(self.idx["mean"], dtype=np.float64)
        self.ids = self.idx["ids"]
        g = json.load(open(DATA / "globe.json", encoding="utf-8"))
        pos = {p["id"]: (p["lat"], p["lon"]) for p in g["points"]}
        la = np.radians([pos[i][0] for i in self.ids]); lo = np.radians([pos[i][1] for i in self.ids])
        self.xyz = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)
        pts = {p["id"]: p for p in json.load(open(DATA / "points.json", encoding="utf-8"))}
        self.tags = {ax: [pts[i].get(ax) for i in self.ids] for ax in ("mv", "mt", "fr")}
        self._model = None

    def embed(self, texts):
        if self._model is None:
            from fastembed import TextEmbedding
            self._model = TextEmbedding("BAAI/bge-small-en-v1.5", cache_dir=str(ROOT / ".cache" / "models"))
        e = np.array(list(self._model.embed(texts)), dtype=np.float64)
        e /= np.linalg.norm(e, axis=1, keepdims=True)
        return self.center(e)

    def center(self, e):
        v = e - self.mean
        return v / np.linalg.norm(v, axis=1, keepdims=True)

    def place(self, v, skip=None):
        c = self.X @ np.asarray(v, dtype=np.float32)
        if skip is not None:
            c[skip] = -9
        nb = np.argsort(-c)[:K]
        cs = c[nb].astype(np.float64)
        w = np.maximum(cs - cs[-1] + 0.02, 1e-9)
        s = (w[:, None] * self.xyz[nb]).sum(0)
        r = float(np.linalg.norm(s) / w.sum())
        p = s / np.linalg.norm(s)
        lat = math.degrees(math.asin(max(-1, min(1, p[2])))); lon = math.degrees(math.atan2(p[1], p[0]))
        guess = {}
        for ax in ("mv", "mt", "fr"):
            tot, cnt = Counter(), Counter()
            for j, wj in zip(nb, w):
                t = self.tags[ax][j]
                if t:
                    tot[t] += wj; cnt[t] += 1
            if cnt:
                best = max(cnt, key=lambda t: (cnt[t], tot[t]))
                guess[ax] = {"value": best, "votes": cnt[best], "of": int(sum(cnt.values()))}
            else:
                guess[ax] = None
        return {"lat": round(lat, 3), "lon": round(lon, 3), "R": round(r, 4),
                "neighbours": [self.ids[j] for j in nb], "cos": [round(float(x), 4) for x in cs],
                "facets": guess}


def selftest(pl):
    worst = 0.0; ok = True
    for c in pl.idx["selftest"]["cases"]:
        r = pl.place(c["vector"], skip=c["skip_row"])
        dl = abs(r["lat"] - c["lat"]); dn = abs((r["lon"] - c["lon"] + 180) % 360 - 180)
        same = r["neighbours"] == c["neighbours"]
        worst = max(worst, dl, dn); ok &= same and dl < 0.01 and dn < 0.01
        print(f"selftest {c['item']}: got ({r['lat']},{r['lon']}) want ({c['lat']},{c['lon']}) neighbours_match={same}")
    print("SELFTEST", "PASS" if ok else "FAIL", f"max_abs_diff_deg={worst:.4f}")
    return ok


def main():
    pl = Placer()
    ok = selftest(pl)
    if "--selftest" in sys.argv or not ok:
        sys.exit(0 if ok else 1)
    ev = json.load(open(ROOT / "results" / "evidence.json", encoding="utf-8"))
    codes = json.load(open(DATA / "codes.json", encoding="utf-8"))
    dos = ev["dossier"]
    ranking = {r["id"]: r["total"] for r in ev.get("ranking", [])}

    concepts, texts = [], []
    for d in dos:
        axes = d["land"]["target_hole_id"].replace("hole-", "").rsplit("-", 1)[0].replace("-", "×")
        a, b = d["cell"].split(" x ", 1)
        code = codes.get(f"{axes}|{a}|{b}")
        if code is None:
            raise SystemExit(f"no OV code for {d['id']}: {axes}|{a}|{b}")
        o = {"id": d["id"], "hole": d["hole"], "code": code, "cell": d["cell"], "title": d["title"],
             "text": d["text"], "pitch": d["pitch"],
             "land": {k: d["land"].get(k) for k in ("lands_in_gap", "pct_bge", "pct_nomic", "cos_to_target", "nearest_cos", "nearest_title")},
             "prior_art_ai": d["prior_art_ai"]["verdict"], "prior_art_product": d["prior_art_product"]["verdict"],
             "score": ranking.get(d["id"])}
        if d["id"] == "H1-c1":
            o["picked"] = True; o["name"] = "Drift"
        concepts.append(o); texts.append(d["text"])
    for o, v in zip(concepts, pl.embed(texts)):
        r = pl.place(v); o.update(lat=r["lat"], lon=r["lon"], R=r["R"], facets=r["facets"])

    pa = {}
    for d in dos:
        for key in ("prior_art_ai", "prior_art_product"):
            for c in d[key]["closest"]:
                if c.get("how_close", 0) >= 0.3:
                    e = pa.setdefault(c["url"], {"url": c["url"], "what": c["what"], "how_close": c["how_close"],
                                                 "uses_ai": bool(c.get("uses_ai")), "threatens": [], "context": []})
                    e["how_close"] = max(e["how_close"], c["how_close"])
                    e["uses_ai"] = e["uses_ai"] or bool(c.get("uses_ai"))
                    if d["id"] not in e["threatens"]:
                        e["threatens"].append(d["id"])
                    e["context"].append({"concept": d["id"], "lens": key[len("prior_art_"):], "verdict": d[key]["verdict"], "how_close": c["how_close"]})
    prior = sorted(pa.values(), key=lambda e: -e["how_close"])
    for e, v in zip(prior, pl.embed([e["what"] for e in prior]) if prior else []):
        r = pl.place(v); e.update(lat=r["lat"], lon=r["lon"], R=r["R"])

    out = {"version": 1, "recipe": "live_index.json r2", "n_corpus": pl.idx["n"], "concepts": concepts, "prior_art": prior}
    (DATA / "overlays.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for f in ("live_index.bin", "live_index.json"):
        shutil.copyfile(GL / f, DATA / f)
    print(f"overlays.json: {len(concepts)} concepts, {len(prior)} prior_art")


if __name__ == "__main__":
    main()
