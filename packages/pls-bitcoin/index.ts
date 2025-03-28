import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import type { Taptree } from "bitcoinjs-lib/src/types.js";
import { sortScriptsIntoTree } from "./huffman.js";
export interface UTXO {
	txid: string;
	vout: number;
	value: number;
}
import type { ECPairInterface } from "ecpair";
import { ECPairFactory } from "ecpair";
import {
	script,
	type Network,
	payments,
	Psbt,
} from "bitcoinjs-lib";
import { PubkeysSchema } from "pls-core";
import { z } from "zod";

import * as ecc from "tiny-secp256k1";

const ECPair = ECPairFactory(ecc);

type CreateKeyTweakerArgs = {
	pubkey: Buffer;
	privkey?: Buffer;
}

export function createKeyTweaker({ pubkey, privkey }: CreateKeyTweakerArgs) {
	return {
		pubkey,
		privkey,
		tweakPubkey(tweak: Buffer) {
			const xOnlyPubkey = toXOnly(this.pubkey);

			const tweakedPubkey = ecc.xOnlyPointAddTweak(xOnlyPubkey, tweak);

			if (!tweakedPubkey)
				throw new Error('tweak fail');

			const parityByte = Buffer.from([
				tweakedPubkey.parity === 0 ? 0x02 : 0x03,
			]);

			return Buffer.concat([
				parityByte,
				Buffer.from(tweakedPubkey.xOnlyPubkey),
			]);
		},
		tweakPrivkey(tweak: Buffer) {
			if (!this.privkey)
				throw new Error('private key is not present');

			const pubkey = this.pubkey;

			const hasOddY = pubkey[0] === 3 || (pubkey[0] === 4 && ((pubkey[64] || 0) & 1) === 1);

			const privateKey = hasOddY ? ecc.privateNegate(this.privkey) : this.privkey;

			const tweakedPrivkey = ecc.privateAdd(privateKey, tweak);

			if (!tweakedPrivkey)
				throw new Error('tweak fail');

			return Buffer.from(tweakedPrivkey);
		},
		tweakEcpair(tweak: Buffer) {
			if (this.privkey)
				return ECPair.fromPrivateKey(this.tweakPrivkey(tweak));

			return ECPair.fromPublicKey(this.tweakPubkey(tweak));
		},
	}
}

const TaprootV0CollateralSchema = {
	arbitratorsQuorum: z.number(),
	multisigAddress: z.string(),
	pubkeys: PubkeysSchema,
	type: z.literal("taproot-v0"),
};

export const bitcoinSchemas = {
	mainnet: z.object({
		network: z.literal("bitcoin"),
		...TaprootV0CollateralSchema,
	}),
	testnet: z.object({
		network: z.literal("bitcoin_testnet"),
		...TaprootV0CollateralSchema,
	}),
};

// Invalid point, there is not priv key to sign this, should be random
export const H = Buffer.from(
	"50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
	"hex"
);

export const combine = <T>(items: Array<T>, size: number): Array<Array<T>> => {
	const intCombine = (
		acc: Array<T>,
		rem: Array<T>,
		curr: number
	): Array<any> => {
		if (curr === 0) return acc;
		return rem.map((i, idx) => {
			return intCombine([...acc, i], rem.slice(idx + 1), curr - 1);
		});
	};

	return intCombine([], items, size).flat(size - 1);
};

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
