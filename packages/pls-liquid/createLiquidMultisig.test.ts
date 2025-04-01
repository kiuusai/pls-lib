import { describe, expect, test } from "vitest";
import * as ecc from "tiny-secp256k1";
import { createLiquidMultisig } from "./createLiquidMultisig.js";
import { ECPairFactory } from "ecpair";
import {
	crypto,
	networks,
	bip341,
	address as Address,
	script as Script,
	payments,
	Transaction,
} from "liquidjs-lib";
import { combine, H, toReversed, zkpLib } from "./utils/index.js"
import { createKeyTweaker } from "pls-bitcoin/createKeyTweaker.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { script as bitcoinscript } from "bitcoinjs-lib";
import {
	takeFromFaucet,
	retryWithDelay,
	getTransactionHexById,
	publishTransaction,
} from "./utils/test.js"
import { serializeSchnnorrSig } from "./utils/index.js";
import {
  CreatorOutput,
	Blinder as PsetBlinder,
	Signer as PsetSigner,
	Finalizer as PsetFinalizer,
	Pset,
	Creator as PsetCreator,
	Updater as PsetUpdater,
  witnessStackToScriptWitness,
	Extractor as PsetExtractor,
} from "liquidjs-lib/src/psetv2";
import { ZKPGenerator, ZKPValidator } from "./myZKP.js";
import { faker } from "@faker-js/faker";

const ECPair = ECPairFactory(ecc);

const randomArbitrators = faker.number.int({ min: 1, max: 5 });
const randomArbitratorsQuorum = faker.number.int({ min: 1, max: randomArbitrators });

describe.each([
	{
		partsCount: 2,
		arbitratorsCount: 1,
		arbitratorsQuorum: 1,
	},
	{
		partsCount: 2,
		arbitratorsCount: randomArbitrators,
		arbitratorsQuorum: randomArbitratorsQuorum,
	},
])(
	"createLiquidMultisig test with $partsCount parts, $arbitratorsCount arbitrators and arbitrators quorum of $arbitratorsQuorum",
	async ({
		partsCount,
		arbitratorsCount,
		arbitratorsQuorum,
	}) => {
		const clientsKeypairs = new Array(partsCount).fill(null).map(() => ECPair.makeRandom());

		const arbitratorsKeypairs = new Array(arbitratorsCount).fill(null).map(() => ECPair.makeRandom());

		const blindingKeypair = ECPair.makeRandom();

		const dataToTweak = "Some value to tweak";

		const tweak = crypto.sha256(Buffer.from(dataToTweak));

		const network = networks.regtest;

		const eachChildNodeWithArbitratorsQuorum = clientsKeypairs.map(
			(p) => combine(arbitratorsKeypairs, arbitratorsQuorum).map((a) => [p, ...a])
		).flat(1);

		const childNodesCombinations = [
			clientsKeypairs,
			...eachChildNodeWithArbitratorsQuorum,
		];

		const parts = clientsKeypairs.map((keypairs) => keypairs.publicKey.toString("hex"));

		const arbitrators = arbitratorsKeypairs.map((keypairs) => keypairs.publicKey.toString("hex"));

		test("liquid multisig assembly", async () => {
			const multisig = createLiquidMultisig({
				parts,
				arbitrators,
				arbitratorsQuorum,
				network,
				blindingKeypair,
				tweak,
			});

			const tweakedChildNodesCombinations = childNodesCombinations.map((childNodes) => childNodes.map((childNode) => {
				const tweaker = createKeyTweaker({
					pubkey: childNode.publicKey,
					privkey: childNode.privateKey,
				});

				return tweaker.tweakPubkey(tweak).toString("hex");
			}));

			const multisigAsms = tweakedChildNodesCombinations.map(
				(childNodes) => childNodes.map((childNode) => toXOnly(Buffer.from(childNode, "hex")).toString("hex"))
					.map((pubkey, idx) => pubkey + " " + (idx ? "OP_CHECKSIGADD": "OP_CHECKSIG"))
					.join(" ") + ` OP_${childNodes.length} OP_NUMEQUAL`
			);

			const multisigScripts = multisigAsms.map((ma, idx) => ({
				weight: idx ? 1 : 5,
				leaf: { output: bitcoinscript.fromASM(ma) },
				combination: tweakedChildNodesCombinations[idx],
			}));

			const hashTree = bip341.toHashTree(
				multisigScripts.map(({ leaf }) => ({
					scriptHex: leaf.output.toString("hex"),
				})),
				true,
			);

			const treeHash = hashTree.hash;

			const internalXOnlyPubkey = toXOnly(H);
			const toTweak = Buffer.concat([internalXOnlyPubkey, treeHash]);
			const tweakHash = crypto.taggedHash("TapTweak/elements", toTweak);
			const tweaked = ecc.xOnlyPointAddTweak(internalXOnlyPubkey, tweakHash);

			expect(tweaked).not.toBeNull();

			const xOnlyScriptPubkey = tweaked!.xOnlyPubkey;

			const outputScript = Buffer.concat([Buffer.of(0x51, 0x20), xOnlyScriptPubkey]);

			const address = Address.fromOutputScript(outputScript, network);

			const confidentialAddress = Address.toConfidential(
				address,
				blindingKeypair.publicKey,
			);

			const expectedMultisig = {
				address,
				confidentialAddress,
				multisigScripts,
				hashTree,
				leaves: multisigScripts.map((script) => ({
					scriptHex: script.leaf.output.toString("hex"),
				}))
			};

			expect(multisig).toEqual(expectedMultisig);

			const multisigScriptsCombination = multisig.multisigScripts.map((script) => script.combination);
			expect(multisigScriptsCombination).toEqual(tweakedChildNodesCombinations);

			const multisigScriptsAsm = multisig.multisigScripts.map((script) => bitcoinscript.toASM(script.leaf.output));
			expect(multisigScriptsAsm).toEqual(multisigAsms);
		}, { concurrent: true });

		test.each(childNodesCombinations)(
			"liquid multisig spending with each possible combination test %#",
			async (...selectedCombination) => {
				const multisig = createLiquidMultisig({
					parts,
					arbitrators,
					arbitratorsQuorum,
					network,
					blindingKeypair,
					tweak,
				});

				const inputTransactionId = await takeFromFaucet(multisig.confidentialAddress);

	      const inputTransactionHex = await retryWithDelay(
		      () => getTransactionHexById(inputTransactionId),
		      500,
		      30,
	      );

				const inputTransaction = Transaction.fromHex(inputTransactionHex);

				const tweakedSelectedCombination = selectedCombination.map((ecpair) => {
					const tweaker = createKeyTweaker({
						pubkey: ecpair.publicKey,
						privkey: ecpair.privateKey,
					});

					return tweaker.tweakPubkey(tweak).toString("hex");
				});

				const script = multisig.multisigScripts.find(({ combination }) => tweakedSelectedCombination.every(
					(ecpair) => combination.includes(ecpair)
				));

				expect(script).not.toBeUndefined();

				const inputTxOutputs = inputTransaction.outs
					.map((output, vout) => ({ ...output, vout }))
					.filter(
						(output) => output.script.toString("hex") === Address
							.toOutputScript(multisig.address, network)
							.toString("hex")
					);

				expect(inputTxOutputs.length).toBe(1);

				const bip341Api = bip341.BIP341Factory(zkpLib.ecc);

				const pset = PsetCreator.newPset();
				const updater = new PsetUpdater(pset);

				const asset = network.assetHash;

				const unblindedUtxos = inputTxOutputs.map((output) => ({
					txid: inputTransactionId,
					txIndex: output.vout,
					witnessUtxo: Transaction.fromHex(inputTransactionHex).outs[output.vout]!,
					sighashType: Transaction.SIGHASH_ALL,
					value: undefined,
				}));

				updater.addInputs(unblindedUtxos);

				const firstEcpairAddress = payments.p2pkh({
					pubkey: selectedCombination[0]!.publicKey,
					network,
				});

				const firstEcpairConfidentialAddress = Address.toConfidential(
					firstEcpairAddress.address!,
					blindingKeypair.publicKey,
				);

				updater.addOutputs([
					new CreatorOutput(
						asset,
						100_000_000 - 300,
						Address.toOutputScript(firstEcpairAddress.address!, network),
						Address.fromConfidential(firstEcpairConfidentialAddress).blindingKey,
						0,
					),
					new CreatorOutput(asset, 300),
				]);

				const redeemOutput = script!.leaf.output.toString("hex");

				const leafHash = bip341.tapLeafHash({
					scriptHex: redeemOutput,
				});
				const pathToLeaf = bip341.findScriptPath(multisig.hashTree, leafHash);
				const [tapscript, controlBlock] = bip341Api.taprootSignScriptStack(
					H,
					{ scriptHex: redeemOutput },
					multisig.hashTree.hash,
					pathToLeaf,
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
					Pset.ECCKeysGenerator(ecc),
				);

				const blinder = new PsetBlinder(
					pset,
					ownedInputs,
					// @ts-expect-error see ./myZKP.ts for more info
					zkpValidator,
					zkpGenerator
				);
				blinder.blindLast({ outputBlindingArgs });

				const signer = new PsetSigner(pset);

				selectedCombination.map((keypair) => {
					pset.inputs.map(async (_, i) => {
						const hashType = pset.inputs[i]!.sighashType || Transaction.SIGHASH_ALL;

						const sighashmsg = pset.getInputPreimage(
							i,
							hashType,
							network.genesisBlockHash,
							leafHash,
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
					});
				});

				const selectedCombinationSigs = tweakedSelectedCombination.map(
					(pubkey) => pset.inputs[0]!.tapScriptSig!.find(
						(sig) => sig.pubkey.toString("hex") === pubkey
					)?.signature ?? null
				);

				const finalizer = new PsetFinalizer(pset);

				pset.inputs.forEach((_, index) => {
					finalizer.finalizeInput(index, () => {
						const input = pset.inputs[index]!;

						const unlockingScript = Script.compile([
							...toReversed(selectedCombinationSigs).reduce((acc: Buffer[], sig) => {
								if (sig) acc.push(sig);
								return acc;
							}, []),
						]);

						const redeemPayment = payments.p2wsh({
							redeem: {
								input: unlockingScript,
								output: input.witnessScript,
							},
						});

						const finalScriptWitness = witnessStackToScriptWitness(
							redeemPayment.witness ?? [],
						);

						return {
							finalScriptSig: Buffer.from(""),
							finalScriptWitness,
						};
					});
				});

				finalizer.finalize();

				const transaction = PsetExtractor.extract(pset);

				await publishTransaction(transaction.toHex());
			},
			{
				timeout: 30 * 1000,
				concurrent: true,
			}
		)
	},
	{
		concurrent: true,
	},
)
