# Changelog

## Unreleased

## 0.2.3 — 2026-11-10
- `smx_list_markets` and `smx_get_market` include a rules link and short rules text on every market: `rulesUrl` (`https://smx.space/app/markets/{id}`), `rules` (indexer `rules.summary`, otherwise `why`), `rulesHash`, `rulesClose` and `rulesSource`. `smx_get_market` also sets `links.rules`. The question prefers the indexer question, then the built-in question list.
- Rules are read from `GET /v1/markets` on the SMX indexer (default `https://smx-indexer-preview.fly.dev`), cached for 60 seconds, with a 4 second timeout. If the indexer is down or slow, the tools still succeed and `rules`, `rulesHash` and `rulesClose` are null.
- Fix: build orders, claims and cancels against the Factory that matches each market's registry. Before, every build used the legacy Factory 0x409c…b28a, so a wallet onboarded through smx_build_order got an Account that the launch books (registry 0xcD29…4AcD, Factory 0x1F13…E214) reject with NotMarket() (0xc4bbea69). New `factory` and `marketRegistry` fields in smx_build_order output; smx_get_market and smx_trading_guide report the right Factory. Override with SMX_FACTORIES="registry:factory,…".
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
