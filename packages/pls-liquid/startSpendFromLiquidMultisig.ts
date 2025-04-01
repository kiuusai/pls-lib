import type { HashTree } from "liquidjs-lib/src/bip341.js";
import {
	networks,
	bip341,
	Transaction,
	address as Address,
} from "liquidjs-lib";
import type { ECPairInterface } from "ecpair";
import {
	Creator as PsetCreator,
	Updater as PsetUpdater,
	CreatorOutput,
	Blinder as PsetBlinder,
	Pset,
} from "liquidjs-lib/src/psetv2";
import { H, zkpLib } from "./utils/index.js" 
import { getUnblindedUtxoValues } from "./getUnblindedUtxoValues.js";
import { ZKPGenerator, ZKPValidator } from "./myZKP.js";
import * as ecc from "tiny-secp256k1";
import { signLiquidTaprootTransaction } from "./signLiquidTaprootTransaction.js";

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
