// Factory per registry: offline mapping, then a live Base Sepolia check that each Factory points at its registry.
// Set SMX_SKIP_CHAIN=1 to run only the offline half.
import assert from "node:assert/strict";
const { CONTRACTS, factoryFor } = await import("../dist/config.js");
const { factoryOf } = await import("../dist/order-build.js");

const LEGACY_REG = "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a", LAUNCH_REG = "0xcD293b4B311845C023772CDd8738849E1a274AcD";
const LEGACY_F = "0x409cFe0157aE3Ec2C321F97422a4bFc539c4b28a", LAUNCH_F = "0x1F138B48CF923097e7166c01Ee97719a0CfEE214";

assert.equal(factoryFor(LEGACY_REG), LEGACY_F);
assert.equal(factoryFor(LAUNCH_REG), LAUNCH_F);
assert.equal(factoryFor(LAUNCH_REG.toLowerCase()), LAUNCH_F);
assert.equal(factoryFor("0x0000000000000000000000000000000000000001"), undefined);
assert.equal(factoryOf({ registry: LAUNCH_REG }), LAUNCH_F);
assert.equal(factoryOf({ registry: LEGACY_REG }), LEGACY_F);
assert.equal(factoryOf({}), LEGACY_F); // rows with no registry keep the legacy behaviour
for (const reg of CONTRACTS.marketRegistries) assert.ok(factoryFor(reg), `no Factory mapped for configured registry ${reg}`);

if (!process.env.SMX_SKIP_CHAIN) {
  const { pub } = await import("../dist/chain.js");
  const { parseAbi, getAddress } = await import("viem");
  const abi = parseAbi(["function marketRegistry() view returns (address)"]);
  for (const reg of CONTRACTS.marketRegistries) {
    const f = factoryFor(reg);
    const onChain = getAddress(await pub.readContract({ address: f, abi, functionName: "marketRegistry" }));
    assert.equal(onChain, getAddress(reg), `Factory ${f} points at ${onChain}, not ${reg}`);
  }
  // A launch book's own marketRegistry() must be the launch registry.
  const book = "0xC34529283eFE67D7716885B73ACe00744449d1BE";
  assert.equal(getAddress(await pub.readContract({ address: book, abi, functionName: "marketRegistry" })), LAUNCH_REG);
  console.log("factories: live mapping verified on Base Sepolia");
}
console.log("factories: ok");
