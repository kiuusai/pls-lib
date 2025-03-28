import type { ECPairInterface } from "ecpair";
import {
	payments,
	script,
	type Network
} from "bitcoinjs-lib";
import type { Taptree } from "bitcoinjs-lib/src/types.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { combine, H } from "./utils/index.js";
import { createKeyTweaker } from "./createKeyTweaker.js";
import { sortScriptsIntoTree } from "./huffman.js";

type CreateBitcoinMultisigArgs = {
	publicPartsECPairs: ECPairInterface[];
	publicArbitratorsECPairs: ECPairInterface[];
	arbitratorsQuorum: number;
	network: Network;
	tweak: Buffer;
}

export function createBitcoinMultisig({
	publicPartsECPairs,
	publicArbitratorsECPairs,
	arbitratorsQuorum,
	network,
	tweak,
}: CreateBitcoinMultisigArgs) {
	const eachChildNodeWithArbitratorsQuorum = publicPartsECPairs
		.map((p) =>
			combine(publicArbitratorsECPairs, arbitratorsQuorum).map((a) => [p, ...a])
		)
		.flat(1);
	const childNodesCombinations = [
		publicPartsECPairs,
		...eachChildNodeWithArbitratorsQuorum,
	];

	const tweakedChildNodesCombinations = childNodesCombinations.map((childNodes) => childNodes.map((childNode) => {
		const keyTweaker = createKeyTweaker({
			pubkey: childNode.publicKey,
			privkey: childNode.privateKey,
		});

		return keyTweaker.tweakEcpair(tweak);
	}));

	const multisigAsms = tweakedChildNodesCombinations.map(
		(childNodes) =>
			childNodes
				.map((childNode) => toXOnly(childNode.publicKey).toString("hex"))
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
			leaf: { output: script.fromASM(ma) },
			combination: tweakedChildNodesCombinations[idx]!,
		};
	});

	const scriptTree: Taptree = sortScriptsIntoTree(multisigScripts)!;

	const multisig = payments.p2tr({
		internalPubkey: toXOnly(H),
		scriptTree,
		network,
	});

	return { multisigScripts, multisig };
}
