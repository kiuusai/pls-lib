import {
	networks,
	bip341,
	address as Address,
} from "liquidjs-lib";
import { createKeyTweaker } from "pls-bitcoin";
import { ECPairInterface } from "ecpair";
import { H, combine, taprootOutputScript } from "./utils/index.js"
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { script as bitcoinscript } from "bitcoinjs-lib";

type CreateLiquidMultisigArgs = {
	parts: string[];
	arbitrators: string[];
	arbitratorsQuorum: number;
	network: networks.Network;
	internalPublicKey?: Buffer;
	blindingKeypair: ECPairInterface;
	tweak: Buffer;
}

export function createLiquidMultisig({
	parts,
	arbitrators,
	arbitratorsQuorum,
	network,
	internalPublicKey = H,
	blindingKeypair,
	tweak,
}: CreateLiquidMultisigArgs) {
	const eachChildNodeWithArbitratorsQuorum = parts
		.map((p) => combine(arbitrators, arbitratorsQuorum).map((a) => [p, ...a]))
		.flat(1);
	const childNodesCombinations = [parts, ...eachChildNodeWithArbitratorsQuorum];

	const tweakedChildNodesCombinations = childNodesCombinations.map((childNodes) => childNodes.map((childNode) => {
		const tweaker = createKeyTweaker({
			pubkey: Buffer.from(childNode, "hex"),
		});

		return tweaker.tweakPubkey(tweak).toString("hex");
	}));

	const multisigAsms = tweakedChildNodesCombinations.map(
		(childNodes) =>
			childNodes
				.map((childNode) =>
					toXOnly(Buffer.from(childNode, "hex")).toString("hex")
				)
				.map(
					(pubkey, idx) =>
						pubkey + " " + (idx ? "OP_CHECKSIGADD" : "OP_CHECKSIG")
				)
				.join(" ") + ` OP_${childNodes.length} OP_NUMEQUAL`
	);

	const multisigScripts = multisigAsms.map((ma, idx) => {
		return {
			// when building Taptree, prioritize parts agreement script (shortest path), using 1 for parts script and 5 for scripts with arbitrators
			weight: idx ? 1 : 5,
			leaf: { output: bitcoinscript.fromASM(ma) },
			combination: tweakedChildNodesCombinations[idx]!,
		};
	});

	const hashTree = bip341.toHashTree(
		multisigScripts.map(({ leaf }) => ({
			scriptHex: leaf.output.toString("hex"),
		})),
		true
	);

	const scriptPubKey = taprootOutputScript(internalPublicKey, hashTree);

	const address = Address.fromOutputScript(scriptPubKey, network);

	return {
		address,
		confidentialAddress: Address.toConfidential(
			address,
			blindingKeypair.publicKey
		),
		multisigScripts,
		hashTree,
		leaves: multisigScripts.map((script) => ({
			scriptHex: script.leaf.output.toString("hex"),
		})),
	};
}