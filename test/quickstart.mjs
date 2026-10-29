// The README QUICKSTART is the path an outside agent follows to a first quote.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const section = readme.split(/^## QUICKSTART\s*$/m)[1]?.split(/^## /m)[0];
assert.ok(section, "README is missing a ## QUICKSTART section");
assert.ok(section.length < 2500, "QUICKSTART is longer than a few-minute path");

assert.match(section, /live on testnet/i);
assert.match(section, /npx -y smx-mcp/);
assert.match(section, /npm install/);
assert.match(section, /https:\/\/smx\.space\/mcp/);
assert.match(section, /smx_list_markets/);
assert.match(section, /smx_get_market/);
assert.match(section, /bestBidBps/);
assert.match(section, /perps_quote/);
assert.match(section, /Claude Desktop/);
assert.match(section, /Cursor/);
assert.match(section, /"url": "https:\/\/smx\.space\/mcp"/);

assert.doesNotMatch(section, /launching/i);
assert.doesNotMatch(section, /mainnet/i);

console.log("quickstart OK");
