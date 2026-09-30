// Prints the x402 payer (masked) Circle testnet USDC balance on Base Sepolia. Reads X402_PRIVATE_KEY; never prints it.
import { pub } from "../dist/chain.js";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const k = process.env.X402_PRIVATE_KEY; const a = privateKeyToAccount(k.startsWith("0x") ? k : `0x${k}`).address;
const b = await pub.readContract({ address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] });
console.log(a.slice(0, 6) + "…" + a.slice(-4), "Circle test USDC", Number(b) / 1e6, "chain", await pub.getChainId());
