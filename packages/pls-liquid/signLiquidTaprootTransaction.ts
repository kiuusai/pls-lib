import { Pset } from "liquidjs-lib";
import type { ECPairInterface } from "ecpair";
import {
	networks,
	Transaction,
} from "liquidjs-lib";
import {
	Signer as PsetSigner,
} from "liquidjs-lib/src/psetv2";
import { createKeyTweaker } from "pls-bitcoin/createKeyTweaker.js";
import { serializeSchnnorrSig, zkpLib } from "./utils/index.js";

type SignTaprootTransactionArgs = {
	pset: Pset;
	keypair: ECPairInterface;
	leafHash: Buffer;
	network: networks.Network;
	sighashType?: number;
	tweak: Buffer;
}

export async function signLiquidTaprootTransaction({
	pset,
	keypair,
	leafHash,
	network,
	sighashType = Transaction.SIGHASH_ALL,
	tweak,
}: SignTaprootTransactionArgs) {
	const signer = new PsetSigner(pset);

	await Promise.all(
		pset.inputs.map(async (_, i) => {
			const hashType = pset.inputs[i]!.sighashType || sighashType;

			const sighashmsg = pset.getInputPreimage(
				i,
				hashType,
				network.genesisBlockHash,
				leafHash
			);

			const tweakedKeypair = (() => {
				const tweaker = createKeyTweaker({
					pubkey: keypair.publicKey,
					privkey: keypair.privateKey,
				});

				return tweaker.tweakEcpair(tweak);
			})()

			const sig = tweakedKeypair.signSchnorr(sighashmsg);

			const taprootData = {
				tapScriptSigs: [
					{
						signature: serializeSchnnorrSig(Buffer.from(sig), hashType),
						pubkey: tweakedKeypair.publicKey.slice(1),
						leafHash,
					},
				],
				genesisBlockHash: network.genesisBlockHash,
			};

			signer.addSignature(i, taprootData, Pset.SchnorrSigValidator(zkpLib.ecc));
		})
	);
}
