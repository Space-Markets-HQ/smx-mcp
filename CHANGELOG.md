# Changelog

## Unreleased
- QUICKSTART: npx or npm, hosted `https://smx.space/mcp`, list markets, read a quote, Claude and Cursor config. The venue is live on testnet.
- Closed, paused, resolved and expired markets return a structured error with `state` and `reason` (for example `market closed at <time>` or `market paused`).

## 0.2.2 — 2026-10-29
- List, quote and build unsigned orders from every configured Base Sepolia MarketRegistry (`SMX_REGISTRIES`). The default adds `0xcD293b4B311845C023772CDd8738849E1a274AcD` beside the original registry. The same market id is de-duplicated (later registry wins). One registry that cannot be read does not hide the others.
- The 10 TEST-V7/V8 markets on that second registry are live on testnet.

## 0.2.1 — 2026-10-23
- List both MarketRegistries, so the 10 TEST-V7/V8 launch-book twins on 0xcD29…4AcD are visible.
- Hide six slug test markets (starship-reflight-{mar27,jun27,dec27}-test, starship-shipcatch-{nov26,dec26,mar27}-test). Override with SMX_HIDDEN_MARKETS.
- SMX_API override; paused trading status.

## 0.2.0
- Marketplace build: all tools free, telemetry opt-in, ToS link and jurisdiction notice.
