import { describe, expect, test } from "vitest"
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import * as bitcoin from "bitcoinjs-lib";
import { combine, createBitcoinMultisig, createKeyTweaker, H, startTxSpendingFromMultisig } from "./index.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { faker } from "@faker-js/faker";
import { sortScriptsIntoTree } from "./huffman.js";
import {
  takeFromFaucet,
  retryWithDelay,
  getTransactionHexById,
  publishTransaction,
} from "./utils/test.js"

const ECPair = ECPairFactory(ecc);

type CreateBitcoinMultisigTableElement = {
  parts: number;
  arbitrators: number;
  arbitratorsQuorum: number;
  withTweak: boolean;
}

const randomArbitrators = faker.number.int({ min: 1, max: 5 });
const randomArbitratorsQuorum = faker.number.int({ min: 1, max: randomArbitrators });

const createBitcoinMultisigTableElementsWithoutTweak = [
  {
    parts: 2,
    arbitrators: 1,
    arbitratorsQuorum: 1,
    withTweak: false,
  },
  {
    parts: 2,
    arbitrators: randomArbitrators,
    arbitratorsQuorum: randomArbitratorsQuorum,
    withTweak: false,
  },
];

const createBitcoinMultisigTableElementsWithTweak = createBitcoinMultisigTableElementsWithoutTweak.map(el => ({
  ...el,
  withTweak: true,
}));

const createBitcoinMultisigTableElements = [
  ...createBitcoinMultisigTableElementsWithoutTweak,
  ...createBitcoinMultisigTableElementsWithTweak,
];

describe.each<CreateBitcoinMultisigTableElement>(createBitcoinMultisigTableElements)(
  "createBitcoinMultisig test with $parts parts, $arbitrators arbitrators, arbitrators quorum of $arbitratorsQuorum and withTweak as $withTweak",
  async ({
    parts,
    arbitrators,
    arbitratorsQuorum,
    withTweak,
  }) => {
    const partsEcpairs = new Array(parts).fill(null).map(() => ECPair.makeRandom());
    const arbitratorsEcpairs = new Array(arbitrators).fill(null).map(() => ECPair.makeRandom());

    const contentToTweak = "Some content to tweak";
    const tweak = bitcoin.crypto.sha256(Buffer.from(contentToTweak));

    const network = bitcoin.networks.regtest;

    const eachChildNodeWithArbitratorsQuorum = partsEcpairs.map(
      (p) => combine(arbitratorsEcpairs, arbitratorsQuorum).map((a) => [p, ...a])
    ).flat(1);

    const childNodesCombinations = [
      partsEcpairs,
      ...eachChildNodeWithArbitratorsQuorum,
    ];

    test("bitcoin multisig assembly", () => {
      const multisig = createBitcoinMultisig(
        partsEcpairs,
        arbitratorsEcpairs,
        arbitratorsQuorum,
        network,
        withTweak ? tweak : undefined,
      );

      const tweakedChildNodesCombinations = withTweak ? childNodesCombinations.map((childNodes) => childNodes.map((childNode) => {
        const keyTweaker = createKeyTweaker({
          pubkey: childNode.publicKey,
          privkey: childNode.privateKey,
        });

        return keyTweaker.tweakEcpair(tweak);
      })) : childNodesCombinations;

      const multisigAsms = tweakedChildNodesCombinations.map(
        (childNodes) => childNodes.map((childNode) => toXOnly(childNode.publicKey).toString("hex"))
          .map((pubkey, idx) => pubkey + " " + (idx ? "OP_CHECKSIGADD": "OP_CHECKSIG"))
          .join(" ") + ` OP_${childNodes.length} OP_NUMEQUAL`
      );

      const multisigScripts = multisigAsms.map((ma, idx) => ({
        weight: idx ? 1 : 5,
        leaf: { output: bitcoin.script.fromASM(ma) },
        combination: tweakedChildNodesCombinations[idx],
      }));

      const scriptTree = sortScriptsIntoTree(multisigScripts);

      const multisigData = bitcoin.payments.p2tr({
        internalPubkey: toXOnly(H),
        scriptTree,
        network,
      })

      const expectedMultisig = {
        multisigScripts,
        multisig: multisigData,
      };

      expect(multisig).toEqual(expectedMultisig);

      const multisigScriptsCombinations = multisig.multisigScripts.map(script => script.combination);
      expect(multisigScriptsCombinations).toEqual(tweakedChildNodesCombinations);

      const multisigScriptsAsm = multisig.multisigScripts.map(script => bitcoin.script.toASM(script.leaf.output));
      expect(multisigScriptsAsm).toEqual(multisigAsms);
    });

    test.each(childNodesCombinations)(
      "bitcoin multisig spending with each possible combination test %#",
      async (...selectedCombination) => {
        const multisig = createBitcoinMultisig(
          partsEcpairs,
          arbitratorsEcpairs,
          arbitratorsQuorum,
          network,
          withTweak ? tweak : undefined,
        );

        const inputTransactionId = await takeFromFaucet(multisig.multisig.address!);

	      const inputTransactionHex = await retryWithDelay(
		      () => getTransactionHexById(inputTransactionId),
		      500,
		      30,
	      );

        const inputTransaction = bitcoin.Transaction.fromHex(inputTransactionHex);

        const tweakedSelectedCombination = withTweak ? selectedCombination.map(ecpair => {
          const tweaker = createKeyTweaker({
            pubkey: ecpair.publicKey,
            privkey: ecpair.privateKey,
          });

          return tweaker.tweakEcpair(tweak);
        }) : selectedCombination;

        const script = multisig.multisigScripts.find(
          ({ combination }) => tweakedSelectedCombination.every(
            (ecpair) => combination.map(combination => combination.publicKey.toString("hex"))
              .includes(ecpair.publicKey.toString("hex")),
          ),
        );

        expect(script).not.toBeUndefined();

        const inputTxOutputs = inputTransaction.outs
          .map((output, vout) => ({ ...output, vout }))
          .filter(
            (output) => output.script.toString("hex") === bitcoin.address
              .toOutputScript(multisig.multisig.address!, network)
              .toString("hex")
          );

        expect(inputTxOutputs.length).toEqual(1);

        const multisigRedeem = {
          output: script!.leaf.output,
          redeemVersion: 192,
        };

        const multisigP2tr = bitcoin.payments.p2tr({
          internalPubkey: toXOnly(H),
          scriptTree: multisig.multisig.scriptTree,
          redeem: multisigRedeem,
          network,
        });

        const tapLeafScript = {
          leafVersion: multisigRedeem.redeemVersion,
          script: multisigRedeem.output,
          controlBlock: multisigP2tr.witness![multisigP2tr.witness!.length - 1]!,
        };

        const psbt = new bitcoin.Psbt({ network });

        psbt.addInputs(
          inputTxOutputs.map((output) => ({
            hash: inputTransactionId,
            index: output.vout,
            witnessUtxo: { value: output.value, script: multisigP2tr.output! },
            tapLeafScript: [tapLeafScript],
          }))
        );

        const balanceToSpend = inputTxOutputs.map(output => output.value).reduce((a, b) => a + b, 0) - 300;

        psbt.addOutputs([
          {
            address: multisig.multisig.address!,
            value: balanceToSpend,
          },
        ]);

        await Promise.all(tweakedSelectedCombination.map(async (ecpair) => {
          await psbt.signAllInputsAsync(ecpair);
        }));

        psbt.finalizeAllInputs();

        const tx = psbt.extractTransaction();

        await publishTransaction(tx.toHex());
      },
      {
        timeout: 30 * 1000,
        concurrent: true,
      },
    );
  },
  {
    concurrent: true,
  },
)

describe.each([
  {
    withTweak: false,
  },
  {
    withTweak: true,
  },
])(
  "startTxSpendingFromMultisig test with tweak $withTweak",
  ({ withTweak }) => {
    const partsEcpairs = new Array(2).fill(null).map(() => ECPair.makeRandom());

    const arbitratorEcpair = ECPair.makeRandom();

    const contentToTweak = "Some content to tweak";
    const tweak = bitcoin.crypto.sha256(Buffer.from(contentToTweak));

    const network = bitcoin.networks.regtest;

    const multisig = createBitcoinMultisig(
      partsEcpairs,
      [arbitratorEcpair],
      1,
      network,
      withTweak ? tweak : undefined,
    );

    const tweakedSelectedCombination = withTweak ? partsEcpairs.map(ecpair => {
      const tweaker = createKeyTweaker({
        pubkey: ecpair.publicKey,
        privkey: ecpair.privateKey,
      });

      return tweaker.tweakEcpair(tweak);
    }) : partsEcpairs;


    const firstEcpairAddress = bitcoin.payments.p2pkh({
      pubkey: partsEcpairs[0]!.publicKey,
      network,
    });

    test(
      "spending correctly started", async () => {
        const inputTransactionId = await takeFromFaucet(multisig.multisig.address!);

	      const inputTransactionHex = await retryWithDelay(
		      () => getTransactionHexById(inputTransactionId),
		      500,
		      30,
	      );

        const inputTransaction = bitcoin.Transaction.fromHex(inputTransactionHex);

        const script = multisig.multisigScripts.find(
          ({ combination }) => tweakedSelectedCombination.every(
            (ecpair) => combination.map(combination => combination.publicKey.toString("hex"))
              .includes(ecpair.publicKey.toString("hex")),
          ),
        );

        expect(script).not.toBeUndefined();

        const inputTxOutputs = inputTransaction.outs
          .map((output, vout) => ({ ...output, vout }))
          .filter(
            (output) => output.script.toString("hex") === bitcoin.address
              .toOutputScript(multisig.multisig.address!, network)
              .toString("hex")
          );

        expect(inputTxOutputs.length).toEqual(1);

        const balanceToSpend = inputTxOutputs.map(output => output.value).reduce((a, b) => a + b, 0) - 300;

        const utxos = inputTxOutputs.map((output) => ({
          txid: inputTransactionId,
          vout: output.vout,
          value: output.value,
        }));

        const psbt = await startTxSpendingFromMultisig(
          multisig.multisig,
          script!.leaf.output.toString("hex"),
          partsEcpairs[0]!,
          network,
          [
            {
              address: firstEcpairAddress.address!,
              value: balanceToSpend,
            },
          ],
          utxos,
          undefined,
          withTweak ? tweak : undefined,
        );

        const tweakedSecondEcpair = withTweak ? (() => {
          const tweaker = createKeyTweaker({
            pubkey: partsEcpairs[1]!.publicKey,
            privkey: partsEcpairs[1]!.privateKey,
          });

          return tweaker.tweakEcpair(tweak);
        })() : partsEcpairs[1]!;

        await psbt.signAllInputsAsync(tweakedSecondEcpair);

        psbt.finalizeAllInputs();

        const tx = psbt.extractTransaction();

        await publishTransaction(tx.toHex());
      },
      {
        timeout: 30 * 1000,
      },
    )
  },
  {
    concurrent: true,
  }
)
