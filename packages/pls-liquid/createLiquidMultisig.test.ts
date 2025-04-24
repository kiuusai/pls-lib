import { describe, expect, test } from "vitest";
import * as ecc from "tiny-secp256k1";
import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { ECPairFactory } from "ecpair";
import {
	crypto,
	networks,
	bip341,
	address as Address,
} from "liquidjs-lib";
import { combine, H } from "./utils/index.js"
import { createKeyTweaker } from "pls-bitcoin";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { script as bitcoinscript, script } from "bitcoinjs-lib";
import { faker } from "@faker-js/faker";
import { permute } from "./utils/test.js";

const ECPair = ECPairFactory(ecc);

const randomArbitrators = faker.number.int({ min: 1, max: 5 });
const randomArbitratorsQuorum = faker.number.int({ min: 1, max: randomArbitrators });

describe.each([
	{
		partsCount: 2,
		arbitratorsCount: 1,
		arbitratorsQuorum: 1,
	},
	{
		partsCount: 2,
		arbitratorsCount: randomArbitrators,
		arbitratorsQuorum: randomArbitratorsQuorum,
	},
])(
	"createLiquidMultisig test with $partsCount parts, $arbitratorsCount arbitrators and arbitrators quorum of $arbitratorsQuorum",
	async ({
		partsCount,
		arbitratorsCount,
		arbitratorsQuorum,
	}) => {
		const clientsKeypairs = new Array(partsCount).fill(null).map(() => ECPair.makeRandom());

		const arbitratorsKeypairs = new Array(arbitratorsCount).fill(null).map(() => ECPair.makeRandom());

		const blindingKeypair = ECPair.makeRandom();

		const dataToTweak = "Some value to tweak";

		const tweak = crypto.sha256(Buffer.from(dataToTweak));

		const network = networks.regtest;

		const eachChildNodeWithArbitratorsQuorum = clientsKeypairs.map(
			(p) => combine(arbitratorsKeypairs, arbitratorsQuorum).map((a) => [p, ...a])
		).flat(1);

		const childNodesCombinations = [
			clientsKeypairs,
			...eachChildNodeWithArbitratorsQuorum,
		];

		const parts = clientsKeypairs.map((keypairs) => keypairs.publicKey.toString("hex"));

		const arbitrators = arbitratorsKeypairs.map((keypairs) => keypairs.publicKey.toString("hex"));

		test("liquid multisig assembly", async () => {
			const multisig = createLiquidMultisig({
				parts,
				arbitrators,
				arbitratorsQuorum,
				network,
				blindingKeypair,
				tweak,
			});

			const multisigScriptsMap: Record<string, typeof multisig.multisigScripts[number]> = {};

			childNodesCombinations.forEach((combination) => {
				const combinationPubkeys = combination.map((ecpair) => ecpair.publicKey.toString("hex"));

				const key = combinationPubkeys.join(":");

				const multisigScript = multisig.multisigScripts.find((multisigScript) => {
					return multisigScript.combination.every((pubkey) => combinationPubkeys.includes(pubkey)) && multisigScript.combination.length === combinationPubkeys.length;
				})!;

				multisigScriptsMap[key] = multisigScript;
			});

			for (const combinationKeys in multisigScriptsMap) {
				expect(multisigScriptsMap[combinationKeys]).not.toBeUndefined();

				const multisigScript = multisigScriptsMap[combinationKeys]!;

				const pubkeys = combinationKeys.split(":");

        // Checks if the combination matches with the expected combination
				expect(pubkeys.every((pubkey) => multisigScript.combination.includes(pubkey))).toBeTruthy();

				const isPartsEcpairsPubkeys = parts.every((pubkey) => pubkeys.includes(pubkey));

        // Checks if parts ecpairs has more weight in script trees
        if (isPartsEcpairsPubkeys) {
          expect(multisigScript.weight).toEqual(5);
        } else {
          expect(multisigScript.weight).toEqual(1);
        }

				const eachPossibleCombination = permute(multisigScript.combination);

				const possibleScripts = eachPossibleCombination.map((combination) => {
					const tweakedCombination = combination.map((pubkey) => {
						const tweaker = createKeyTweaker({
							pubkey: Buffer.from(pubkey, "hex"),
						});

						const xOnlyTweakedPubkey = toXOnly(tweaker.tweakPubkey(tweak));

						return xOnlyTweakedPubkey.toString("hex");
					});

					const script = tweakedCombination.map((pubkey, idx) => `${pubkey} ${idx === 0 ? "OP_CHECKSIG" : "OP_CHECKSIGADD"}`).join(" ") + ` OP_${tweakedCombination.length} OP_NUMEQUAL`;

					return script;
				});

				const multisigBitcoinScript = script.toASM(multisigScript.leaf.output);

        // Check if the script is correctly assembled
				expect(possibleScripts.includes(multisigBitcoinScript)).toBeTruthy();
			}

			const hashTree = bip341.toHashTree(
				multisig.multisigScripts.map(({ leaf }) => ({
					scriptHex: leaf.output.toString("hex"),
				})),
				true,
			);

			expect(hashTree).toEqual(multisig.hashTree);

			const treeHash = hashTree.hash;

			const internalXOnlyPubkey = toXOnly(H);
			const toTweak = Buffer.concat([internalXOnlyPubkey, treeHash]);
			const tweakHash = crypto.taggedHash("TapTweak/elements", toTweak);
			const tweaked = ecc.xOnlyPointAddTweak(internalXOnlyPubkey, tweakHash);

			expect(tweaked).not.toBeNull();

			const xOnlyScriptPubkey = tweaked!.xOnlyPubkey;

			const outputScript = Buffer.concat([Buffer.of(0x51, 0x20), xOnlyScriptPubkey]);

			const address = Address.fromOutputScript(outputScript, network);

			expect(multisig.address).toEqual(address);

			const confidentialAddress = Address.toConfidential(
				address,
				blindingKeypair.publicKey,
			);

			expect(multisig.confidentialAddress).toEqual(confidentialAddress);

			const leaves = multisig.multisigScripts.map((script) => ({
				scriptHex: script.leaf.output.toString("hex"),
			}));

			expect(multisig.leaves).toEqual(leaves);
		}, { concurrent: true });
	},
	{
		concurrent: true,
	},
)