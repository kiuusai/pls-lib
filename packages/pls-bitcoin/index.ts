import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
export interface UTXO {
	txid: string;
	vout: number;
	value: number;
}
import type { ECPairInterface } from "ecpair";
import {
	type Network,
	payments,
	Psbt,
} from "bitcoinjs-lib";
import { createKeyTweaker } from "./createKeyTweaker.js";
import { createBitcoinMultisig } from "./createBitcoinMultisig.js";
import { combine, H, bitcoinSchemas } from "./utils/index.js"

export {
	createKeyTweaker,

	createBitcoinMultisig,

	combine,
	H,
	bitcoinSchemas,
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
