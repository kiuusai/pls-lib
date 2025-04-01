import { PubkeysSchema } from "pls-core";
import { z } from "zod";

import {
	payments,
	script,
} from "liquidjs-lib";

import { createKeyTweaker } from "pls-bitcoin";

import { Buffer } from "buffer";

import {
	Finalizer as PsetFinalizer,
	Extractor as PsetExtractor,
	Pset,
	witnessStackToScriptWitness,
} from "liquidjs-lib/src/psetv2";

import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { getUnblindedUtxoValue } from "./getUnblindedUtxoValue.js";
import { getUnblindedUtxoValues } from "./getUnblindedUtxoValues.js";
import { startSpendFromLiquidMultisig } from "./startSpendFromLiquidMultisig.js";
import { signLiquidTaprootTransaction } from "./signLiquidTaprootTransaction.js";

import {
	H,
	toReversed,
} from "./utils/index.js"

export {
	createLiquidMultisig,

	startSpendFromLiquidMultisig,

	signLiquidTaprootTransaction,

	getUnblindedUtxoValue,

	getUnblindedUtxoValues,

	H,
}

const TaprootV0CollateralSchema = {
	arbitratorsQuorum: z.number(),
	multisigAddress: z.string(),
	privateBlindingKey: z.string(),
	pubkeys: PubkeysSchema,
	type: z.literal("taproot-v0"),
};

export const liquidSchemas = {
	mainnet: z.object({
		network: z.literal("liquid"),
		...TaprootV0CollateralSchema,
	}),
	testnet: z.object({
		network: z.literal("liquid_testnet"),
		...TaprootV0CollateralSchema,
	}),
};

type FinalizeTxSpendingFromLiquidMultisigArgs = {
	pset: Pset;
	clientSigs: (Buffer | null)[];
	arbitratorSigs: (Buffer | null)[];
}

export function finalizeTxSpendingFromLiquidMultisig({
	pset,
	clientSigs,
	arbitratorSigs,
}: FinalizeTxSpendingFromLiquidMultisigArgs) {
	const finalizer = new PsetFinalizer(pset);

	pset.inputs.forEach((_, index) => {
		finalizer.finalizeInput(index, (_) => {
			const input = pset.inputs[index];

			const unlockingScript =
				clientSigs[0] && clientSigs[1]
					? script.compile([clientSigs[1], clientSigs[0]])
					: script.compile([
							...toReversed(arbitratorSigs).reduce((acc: Buffer[], sig) => {
								if (sig) acc.push(sig);
								return acc;
							}, []),
							...toReversed(clientSigs).reduce((acc: Buffer[], sig) => {
								if (sig) acc.push(sig);
								return acc;
							}, []),
						]);

			const redeemPayment = payments.p2wsh({
				redeem: {
					input: unlockingScript,
					output: input!.witnessScript,
				},
			});

			const finalScriptWitness = witnessStackToScriptWitness(
				redeemPayment.witness ?? []
			);

			return {
				finalScriptSig: Buffer.from(""),
				finalScriptWitness,
			};
		});
	});

	finalizer.finalize();
	return PsetExtractor.extract(pset);
}

type GetTapscriptSigsOrderedArgs = {
	pset: Pset;
	clientPubkeys: string[];
	arbitratorPubkeys: string[];
	tweak: Buffer;
}

export function getTapscriptSigsOrdered({
	pset,
	clientPubkeys,
	arbitratorPubkeys,
	tweak,
}: GetTapscriptSigsOrderedArgs) {
	const tweakedClientPubkeys = clientPubkeys.map((pubkey) => {
		const tweaker = createKeyTweaker({
			pubkey: Buffer.from(pubkey, "hex"),
		});

		const tweakedPubkey = toXOnly(tweaker.tweakPubkey(tweak));

		return tweakedPubkey.toString("hex");
	});

	const clientSigs = tweakedClientPubkeys.map(
		(pubkey) =>
			pset.inputs[0]!.tapScriptSig!.find(
				(sig) => sig.pubkey.toString("hex") === pubkey
			)?.signature ?? null
	);

	const tweakedArbitratorPubkeys = arbitratorPubkeys.map((pubkey) => {
		const tweaker = createKeyTweaker({
			pubkey: Buffer.from(pubkey, "hex"),
		});

		const tweakedPubkey = toXOnly(tweaker.tweakPubkey(tweak));

		return tweakedPubkey.toString("hex");
	})

	const arbitratorSigs = tweakedArbitratorPubkeys.map(
		(pubkey) =>
			pset.inputs[0]!.tapScriptSig!.find(
				(sig) => sig.pubkey.toString("hex") === pubkey
			)?.signature ?? null
	);

	return {
		clientSigs,
		arbitratorSigs,
	};
}
