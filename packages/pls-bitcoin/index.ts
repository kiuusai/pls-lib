import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import type { Taptree } from "bitcoinjs-lib/src/types.js";
import { sortScriptsIntoTree } from "./huffman.js";
export interface UTXO {
	txid: string;
	vout: number;
	value: number;
}
import type { ECPairInterface } from "ecpair";
import {
	script,
	type Network,
	payments,
	Psbt,
} from "bitcoinjs-lib";
import { createKeyTweaker } from "./createKeyTweaker.js";
import { combine, H, bitcoinSchemas } from "./utils/index.js"

export {
	createKeyTweaker,

	combine,
	H,
	bitcoinSchemas,
}

export function createBitcoinMultisig(
	publicPartsECPairs: ECPairInterface[],
	publicArbitratorsECPairs: ECPairInterface[],
	arbitratorsQuorum: number,
	network: Network,
	tweak?: Buffer,
) {
	const eachChildNodeWithArbitratorsQuorum = publicPartsECPairs
		.map((p) =>
			combine(publicArbitratorsECPairs, arbitratorsQuorum).map((a) => [p, ...a])
		)
		.flat(1);
	const childNodesCombinations = [
		publicPartsECPairs,
		...eachChildNodeWithArbitratorsQuorum,
	];

	const tweakedChildNodesCombinations = tweak !== undefined ? childNodesCombinations.map((childNodes) => childNodes.map((childNode) => {
		const keyTweaker = createKeyTweaker({
			pubkey: childNode.publicKey,
			privkey: childNode.privateKey,
		});

		return keyTweaker.tweakEcpair(tweak);
	})) : childNodesCombinations;

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

export async function startTxSpendingFromMultisig(
	multisig: payments.Payment,
	redeemOutput: string,
	signer: ECPairInterface,
	network: Network,
	receivingAddresses: {
		address: string;
		value: number;
	}[],
	utxos: UTXO[],
	locktime?: number,
	tweak?: Buffer,
) {
	const multisigRedeem = {
		output: Buffer.from(redeemOutput, "hex"),
		redeemVersion: 192,
	};

	const multisigP2tr = payments.p2tr({
		internalPubkey: toXOnly(H),
		scriptTree: multisig.scriptTree,
		redeem: multisigRedeem,
		network,
	});

	const tapLeafScript = {
		leafVersion: multisigRedeem.redeemVersion,
		script: multisigRedeem.output,
		controlBlock: multisigP2tr.witness![multisigP2tr.witness!.length - 1]!,
	};

	const psbt = new Psbt({ network });

	psbt.addInputs(
		utxos.map((utxo) => ({
			hash: utxo.txid,
			index: utxo.vout,
			witnessUtxo: { value: utxo.value, script: multisigP2tr.output! },
			tapLeafScript: [tapLeafScript],
		}))
	);

	if (locktime) {
		psbt.setLocktime(locktime);
		psbt.txInputs.forEach((_, i) => psbt.setInputSequence(i, 0));
	}

	psbt.addOutputs(receivingAddresses);

	const tweakedSigner = tweak ? (() => {
		const tweaker = createKeyTweaker({
			pubkey: signer.publicKey,
			privkey: signer.privateKey,
		});

		return tweaker.tweakEcpair(tweak);
	})() : signer;

	await psbt.signAllInputsAsync(tweakedSigner);

	return psbt;
}
