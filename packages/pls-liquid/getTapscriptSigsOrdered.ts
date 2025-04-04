import { Pset } from "liquidjs-lib";
import { createKeyTweaker } from "pls-bitcoin";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

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