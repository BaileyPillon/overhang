# Corpus schema

Every collector writes one JSON object per line to `corpus/raw/<slice>.jsonl` (UTF-8, no BOM).

```json
{"id": "devices-001", "title": "Ad-free Android TV dashboard", "text": "Connects to an Android TV over ADB, strips the launcher ads, and replaces the screensaver with a live revenue and calendar dashboard.", "domain": "devices-home", "source": "https://x.com/...", "who": "@handle", "date": "2026-10", "from_video": false, "confidence": "seen"}
```

| field | rule |
|---|---|
| `id` | `<slice>-NNN`, zero-padded, unique within the file |
| `title` | 8 words or fewer, plain |
| `text` | **The field that gets embedded. Phrasing must be uniform across all collectors.** 15 to 35 words, one sentence (two at most), present tense, starting with a verb for what was done: what it acted on, how, and what came out. Never say "Claude", "AI", "LLM", "model", "agent" (unless many agents working together is the point), never names or handles, no hype words ("insane", "game-changing"), no prices unless the price is the point. Describe the *use*, not the reaction to it. |
| `domain` | exactly one of: `devices-home`, `security-privacy`, `science-research`, `health-body`, `money-business`, `work-productivity`, `software-dev`, `family-kids`, `creative-media`, `games`, `learning`, `social-relationships`, `civic-legal`, `travel-outdoors`, `food-home-life`, `other` |
| `source` | URL of the page where you actually saw the report (tweet, Reddit post, HN thread, blog, article, repo, Anthropic page). Never invented. |
| `who` | handle or org if known, else `null` |
| `date` | `YYYY-MM` if known, else `null` |
| `from_video` | `true` only for the 31 use cases in the Nick Saraev video |
| `confidence` | `seen` = you read the report itself; `secondhand` = an article or roundup describing it |

Good `text` examples:
- "Reverse-engineers a car head unit's firmware and finds an always-on microphone, a hidden call recorder, and a vendor backdoor."
- "Distills 83 podcast episodes into a playbook by filtering 2,400 minutes of audio down to the 100 stories relevant to developers."
- "Embeds every game on a storefront, samples points between them, and proposes a new game concept from the emptiest region."

Bad: "Claude helped me build an insane dashboard!!" (names the tool, vague, hype).

One real use case per line. If two reports describe the same thing, keep the more concrete one.
