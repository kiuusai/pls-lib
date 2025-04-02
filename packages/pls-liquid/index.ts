import { PubkeysSchema } from "pls-core";
import { z } from "zod";

import { createKeyTweaker } from "pls-bitcoin";

import { Buffer } from "buffer";

import {
	Pset,
} from "liquidjs-lib/src/psetv2";

import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { getUnblindedUtxoValue } from "./getUnblindedUtxoValue.js";
import { getUnblindedUtxoValues } from "./getUnblindedUtxoValues.js";
import { startSpendFromLiquidMultisig } from "./startSpendFromLiquidMultisig.js";
import { signLiquidTaprootTransaction } from "./signLiquidTaprootTransaction.js";
import { finalizeTxSpendingFromLiquidMultisig } from "./finalizeTxSpendingFromLiquidMultisig.js";

import {
	H,
} from "./utils/index.js"

export {
	createLiquidMultisig,

	startSpendFromLiquidMultisig,

	signLiquidTaprootTransaction,

	finalizeTxSpendingFromLiquidMultisig,

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