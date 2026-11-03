# Overhang app data contract

The app reads only the JSON files in `app/public/data/` (UTF-8). They are produced by
`scripts/export_app_data.py` from a gapfind run folder. The app must work for any N
(514 now, about 1,600 after the replication sample is pooled).

```
.venv\Scripts\python.exe -I scripts\export_app_data.py                 # runs/r1 -> app/public/data/
.venv\Scripts\python.exe -I scripts\export_app_data.py --run r2        # pooled run, same codes plus new ones
.venv\Scripts\python.exe -I scripts\export_app_data.py --check         # validate the files only
```

Flags: `--run` (r1), `--out`, `--kappa-json`, `--prereg` (runs/r1/holes.json), `--dry` (runs/dry),
`--map`, `--tags` (repeatable), `--vocab`. Exit code 0 = export and check passed, 1 = check
failed, 2 = missing or invalid input. The script writes only into `--out`.

## Files

### meta.json
```
{"N": int, "N_r1": int, "run": "r1"|"r2",
 "kappa": {"r1": {"move":f,"material":f,"for":f}, "grow": {...}|null},
 "models": ["BAAI/bge-base-en-v1.5","nomic-ai/nomic-embed-text-v1.5"],
 "pca": int, "k": int, "prereg_commit": "363f0e1",
 "repo_url": "https://github.com/BaileyPillon/overhang",
 "video": {"title": "31 Life-Changing Ways to Use Claude in 2027",
           "channel": "Nick Saraev", "url": "https://www.youtube.com/watch?v=KDyPHt4lW60"},
 "generated": "ISO date", "replication_status": "pending"|"done"}
```

### points.json
Array of
`{"id","t" (title),"tx" (text),"d" (domain),"v" (from_video bool),"s" (source url),"w" (who or null),
"dt" (date or null),"c" (confidence),"x","y" (UMAP 2D, floats),"mv","mt","fr" (facet values as strings),
"g" (sampled_by string or null; null for the original 514)}`

### facets.json
```
{"axes": {"move":[{"value","definition"}...],"material":[...],"for":[...]},
 "tables": {"move×material": {"rows":[values],"cols":[values],"observed":[[int]],"expected":[[float]],
                              "expected_indep":[[float]],"structural":[[bool]],"q":[[float|null]]},
            "move×for": {...}, "material×for": {...}}}
```

### holes.json
Array of
```
{"code":"OV-01" (stable catalog code; ranked by E within the primary pair move×material first,
                 then move×for, then material×for),
 "id" (gapfind id), "axes":[a,b], "cell":{a:value,b:value}, "observed":int, "E":float,
 "E_indep":float, "p":float, "q":float|null, "stability":float, "tag_robust":bool, "knn_pct":float,
 "row_ids":[ids carrying the row value], "col_ids":[ids carrying the col value],
 "x":float, "y":float (midpoint of the 2D centroids of row_ids and col_ids),
 "prereg":bool,
 "replication": null | {"verdict","observed_new","E_new","p_new","observed_pooled","E_pooled","q_pooled"},
 "concept": null | {"title","text","pitch"},
 "prior_art": null | {"verdict","closest":[{"url","what","how_close"}]}}
```

### replication.json
```
{"status":"pending"|"done",
 "rows":[{"code","cell_label","axes","E_prereg","observed_new","E_new","p_new","observed_pooled",
          "E_pooled","q_pooled","stability","verdict","refuting":[{"id","t"}]}]}
```

### dryrun.json
```
{"N":514,"chance":float,
 "gaps":[{"rank","pct","stability","coherence","nn_cos","parents":[titles]}]}
```
From `runs/dry/gaps.json` and `runs/dry/stability.json`. `nn_cos` is 1 - g1 of the nearest item.

### winner.json
`{"status":"pending"}` or later
`{"status":"built","code","title","pitch","how_it_works":[...],"demo":{...},"repo_path"}`

### codes.json (support file)
`{"<axes>|<row>|<col>": "OV-NN"}`, for example `"move×material|audit or diagnose|a playable game": "OV-01"`.
`axes` is `move×material`, `move×for` or `material×for`. Codes never change once written; a later
run reuses them and appends new ones after the highest number.

## How the exporter interprets the contract

- **Sources.** Points come from `runs/<run>/items.jsonl` with x,y from `map.json`, else `map_holes.json`
  (r1 has only `map_holes.json`). The same map gives the hole midpoints, so plate and holes always agree.
  Facet values (`mv`,`mt`,`fr`) are the primary (adjudicated) tags, not the second tagger's, taken from the
  tags path recorded in `holes.json` params (default `corpus/facets/tags.jsonl`). A tag outside the
  vocabulary becomes null.
- **Holes.** Every empty cell (observed 0) whose E >= 1 in the three pair tables, E = the quasi-independence
  expectation (`expected`), `E_indep` = plain independence. This list is built from the tables, so it is not
  cut off by gapfind's `--top`. gapfind fields are used where a gapfind hole exists: `p`, `stability` (bootstrap
  probability the cell stays empty), `knn_pct` (gapfind `percentile`, the hole direction's rank among
  k-NN novelty of all items), `tag_robust` (`alt.survives`: still a hole under the second tagger).
  If the run lacks `alt` labels, `tag_robust` is false. `q` is the pair table's Benjamini-Hochberg q
  when `holes.json` has it, else null (r1 predates it).
- **Pre-registered holes.** `prereg` is true for cells that were E >= 1 holes in `runs/r1/holes.json`
  (the registered set). For r1 that is all of them. In a pooled run, a registered cell that is no longer
  E >= 1 (for example because it gained observations) is still emitted, built from the pair tables
  (`observed` from the table, `p` = Poisson P(X <= observed)), so its verdict has a home on the plate.
- **Codes.** Rank key: pair order (move×material, move×for, material×for), then E descending, then p.
  If `codes.json` does not exist yet and the run is a pooled one, the r1 holes are coded first, in that
  order, then the pooled-only holes are appended.
- **Re-runs.** `concept`, `prior_art` and a built `winner.json` that later stages wrote into the output folder
  are carried over on re-export (concepts by code, when the cell is unchanged).
- **Replication.** Absent `runs/<run>/replication.json`: `{"status":"pending","rows":[]}` and every
  hole's `replication` null. Present: rows come from its `cells` (gapfind `replicate` output), joined to
  holes by axes and cell values, never by hole id. `stability` is the cell's bootstrap stability on the
  pooled sample; `refuting` lists the new items in the cell with `t` = title.
- **Kappa.** r1 default is move .878, material .897, for .879; `grow` is null until
  `--kappa-json` supplies it (`{"grow": {...}}`, or a full `{"r1":...,"grow":...}`).
- **Dry run.** `pct` = gapfind percentile of the blend gap, `stability` from `stability.json` (fraction of 9
  re-runs that found the gap), `chance` = the null match rate in `stability.json` (what a random
  direction scores), `coherence` as computed by gapfind.
- **Sampled-by.** `g` is the item's `sampled_by` field (for example `material:a playable game`, or a random
  source); null when the field is absent.
- **Numbers.** x,y 4 decimals; E and probabilities 4 to 6 decimals; table cells 3 decimals as gapfind writes them.
  No NaN or Infinity in any file (null instead).

## Checks (`--check`)

Files present and parseable; field types; unique ids and codes; N equals the number of points and the
first N_r1 points have `g` null; tag values within the vocabulary; every table is rows x cols and its
observed total equals the number of points tagged on both axes; every hole's cell is in the vocabulary,
`observed` and `E` match the table, `row_ids`/`col_ids` are exactly the points carrying the value, x,y is the
centroid midpoint, the code matches `codes.json` and codes ascend in pair order; every empty cell with E >= 1
appears as a hole; replication status agrees across `meta`, `replication.json` and the holes; the dry run has
ranks 1..n and values in range; a built winner names a real code.
