import { PubkeysSchema } from "pls-core";
import { z } from "zod";

import {
	Transaction,
	address as Address,
	networks,
	payments,
	confidential,
	script,
	bip341,
} from "liquidjs-lib";

import { createKeyTweaker } from "pls-bitcoin";

import { Buffer } from "buffer";

import { ECPairInterface } from "ecpair";

import {
	Creator as PsetCreator,
	Updater as PsetUpdater,
	CreatorOutput,
	Signer as PsetSigner,
	Finalizer as PsetFinalizer,
	Extractor as PsetExtractor,
	Blinder as PsetBlinder,
	Pset,
	witnessStackToScriptWitness,
} from "liquidjs-lib/src/psetv2";

import { ZKPGenerator, ZKPValidator } from "./myZKP.js";

import * as ecc from "tiny-secp256k1";

import secp256k1 from "@vulpemventures/secp256k1-zkp";

import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import type { HashTree } from "liquidjs-lib/src/bip341.js";

import { createLiquidMultisig } from "./createLiquidMultisig.js";

import {
	H,
	serializeSchnnorrSig,
    toReversed,
} from "./utils/index.js"

export {
	createLiquidMultisig,

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

// @ts-expect-error I have no idea
const zkpLib: secp256k1 = await secp256k1();

export const Confidential = new confidential.Confidential(zkpLib);

type ReceivingAddress = {
	address: string;
	value: number;
}

type StartSpendFromLiquidMultisigArgs = {
	hashTree: HashTree;
	redeemOutput: string;
	utxos: {
		txid: string;
		hex: string;
		vout: number;
		value: number | undefined;
	}[];
	network: networks.Network;
	signer: ECPairInterface;
	receivingAddresses: ReceivingAddress[];
	tweak: Buffer;
	blindingKeypair: ECPairInterface;
}

export async function startSpendFromLiquidMultisig({
	hashTree,
	redeemOutput,
	utxos,
	network,
	signer,
	receivingAddresses,
	tweak,
	blindingKeypair,
}: StartSpendFromLiquidMultisigArgs) {
	const bip341API = bip341.BIP341Factory(zkpLib.ecc);

	const pset = PsetCreator.newPset();
	const updater = new PsetUpdater(pset);

	const asset = network.assetHash;

	let usedUtxos = utxos.map((utxo) => ({
		txid: utxo.txid,
		txIndex: utxo.vout,
		witnessUtxo: Transaction.fromHex(utxo.hex).outs[utxo.vout]!,
		sighashType: Transaction.SIGHASH_ALL,
		value: utxo.value,
	}));

	const unblindedUtxos = usedUtxos;

	const balance = getUnblindedUtxoValues({
		utxos,
		blindingKeypair,
	}).reduce(
		(acc: number, value) => acc + (value ?? 0),
		0
	);

	const sentAmount = receivingAddresses.reduce(
		(acc, { value }) => acc + value,
		0
	);

	const fees = balance - sentAmount;

	if (fees < 0) {
		return alert("negative fees");
	}

	updater.addInputs(unblindedUtxos);

	updater.addOutputs([
		...receivingAddresses.map(
			({ address, value }) =>
				new CreatorOutput(
					asset,
					value,
					Address.toOutputScript(address, network),
					Address.fromConfidential(address).blindingKey,
					0
				)
		),
		new CreatorOutput(asset, fees),
	]);

	const leafHash = bip341.tapLeafHash({
		scriptHex: redeemOutput,
	});
	const pathToBobLeaf = bip341.findScriptPath(hashTree, leafHash);
	const [tapscript, controlBlock] = bip341API.taprootSignScriptStack(
		H,
		{ scriptHex: redeemOutput },
		hashTree.hash,
		pathToBobLeaf
	);

	unblindedUtxos.forEach((utxo, i) => {
		updater.addInUtxoRangeProof(i, utxo.witnessUtxo.rangeProof!);

		updater.addInTapLeafScript(i, {
			controlBlock: controlBlock!,
			leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
			script: tapscript!,
		});
	});

	const zkpValidator = new ZKPValidator(zkpLib);
	const zkpGenerator = new ZKPGenerator(
		zkpLib,
		ZKPGenerator.WithBlindingKeysOfInputs(
			unblindedUtxos.map(() => blindingKeypair.privateKey!)
		)
	);

	const ownedInputs = zkpGenerator.unblindInputs(pset);
	const outputBlindingArgs = zkpGenerator.blindOutputs(
		pset,
		Pset.ECCKeysGenerator(ecc)
	);
	const blinder = new PsetBlinder(
		pset,
		ownedInputs,
		// @ts-expect-error see ./myZKP.ts for more info
		zkpValidator,
		zkpGenerator
	);
	blinder.blindLast({ outputBlindingArgs });

	await signLiquidTaprootTransaction({
		pset,
		keypair: signer,
		leafHash,
		network,
		tweak,
	});

	return pset;
}

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

type GetUnblindedUtxoValues = {
	utxos: {
		value?: number;
		vout: number;
		hex: string;
	}[];
	blindingKeypair: ECPairInterface;
}

export function getUnblindedUtxoValues({
	utxos,
	blindingKeypair,
}: GetUnblindedUtxoValues) {
	return utxos.map((utxo, index) => getUnblindedUtxoValue({
		utxo,
		index,
		blindingKeypair,
	}));
}

type GetUmblindedUtxoValue = {
	utxo: {
		value?: number;
		vout: number;
		hex: string;
	};
	index?: number;
	blindingKeypair: ECPairInterface;
}

export function getUnblindedUtxoValue({
	utxo,
	index = 0,
	blindingKeypair,
}: GetUmblindedUtxoValue) {
	if (utxo.value) {
		return utxo.value;
	} else {
		try {
			const unblinded = Confidential.unblindOutputWithKey(
				Transaction.fromHex(utxo.hex).outs[utxo.vout]!,
				blindingKeypair.privateKey!
			);

			return Number(unblinded.value);
		} catch (error) {
			console.log(`couldn't unblind UTXO ${index}`);

			return null;
		}
	}
}

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
