import { describe, expect, test } from "vitest";
import { faker } from "@faker-js/faker";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import * as bitcoin from "bitcoinjs-lib";
import { combine, createBitcoinMultisig, createKeyTweaker, H } from "./index.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";
import { sortScriptsIntoTree } from "./huffman.js";
import { permute } from "./utils/test.js";
import { Taptree } from "bitcoinjs-lib/src/types.js";

const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib(ecc);

type CreateBitcoinMultisigTableElement = {
  parts: number;
  arbitrators: number;
  arbitratorsQuorum: number;
}

const randomArbitrators = faker.number.int({ min: 1, max: 5 });
const randomArbitratorsQuorum = faker.number.int({ min: 1, max: randomArbitrators });

const createBitcoinMultisigTableElements = [
  {
    parts: 2,
    arbitrators: 1,
    arbitratorsQuorum: 1,
  },
  {
    parts: 2,
    arbitrators: randomArbitrators,
    arbitratorsQuorum: randomArbitratorsQuorum,
  },
];

describe.each<CreateBitcoinMultisigTableElement>(createBitcoinMultisigTableElements)(
  "createBitcoinMultisig test with $parts parts, $arbitrators arbitrators, arbitrators quorum of $arbitratorsQuorum",
  async ({
    parts,
    arbitrators,
    arbitratorsQuorum,
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
      const multisig = createBitcoinMultisig({
        publicPartsECPairs: partsEcpairs,
        publicArbitratorsECPairs: arbitratorsEcpairs,
        arbitratorsQuorum,
        network,
        tweak,
      });

      const multisigScriptsMap: Record<string, typeof multisig.multisigScripts[number]> = {};

      childNodesCombinations.forEach((combination) => {
        const combinationPubkeys = combination.map((ecpair) => ecpair.publicKey.toString("hex"));

        const key = combinationPubkeys.join(":");

        const multisigScript = multisig.multisigScripts.find((multisigScript) => {
          const multisigCombinationsPubkeys = multisigScript.combination.map((ecpair) => ecpair.publicKey.toString("hex"));

          // Finds the exact multisig script that matches with combination
          return multisigCombinationsPubkeys.every((pubkey) => combinationPubkeys.includes(pubkey)) && multisigCombinationsPubkeys.length === combinationPubkeys.length;
        })!;

        multisigScriptsMap[key] = multisigScript;
      })

      for (const combinationKeys in multisigScriptsMap) {
        expect(multisigScriptsMap[combinationKeys]).not.toBeUndefined();

        const multisigScript = multisigScriptsMap[combinationKeys]!;

        const publicKeys = combinationKeys.split(":");

        const multisigScriptCombinationPubkey = multisigScript.combination.map((ecpair) => ecpair.publicKey.toString("hex"));

        // Checks if the combination matches with the expected combination
        expect(publicKeys.every((pubkey) => multisigScriptCombinationPubkey.includes(pubkey))).toBeTruthy();

        const partsEcpairPubkeys = partsEcpairs.map((ecpair) => ecpair.publicKey.toString("hex"));

        const isPartsEcpairsPubkeys = partsEcpairPubkeys.every((pubkey) => publicKeys.includes(pubkey));

        // Checks if parts ecpairs has more weight in script trees
        if (isPartsEcpairsPubkeys) {
          expect(multisigScript.weight).toEqual(5);
        } else {
          expect(multisigScript.weight).toEqual(1);
        }

        const eachPossibleCombination = permute(multisigScript.combination);

        const possibleScripts = eachPossibleCombination.map((combination) => {
          const tweakedCombination = combination.map((ecpair) => {
            const tweaker = createKeyTweaker({
              pubkey: ecpair.publicKey,
              privkey: ecpair.privateKey,
            });

            return tweaker.tweakEcpair(tweak);
          });

          const tweakedCombinationPubkeys = tweakedCombination.map((ecpair) => toXOnly(ecpair.publicKey).toString("hex"));

          const script = tweakedCombinationPubkeys.map((pubkey, idx) => `${pubkey} ${idx === 0 ? "OP_CHECKSIG" : "OP_CHECKSIGADD"}`).join(" ") + ` OP_${tweakedCombination.length} OP_NUMEQUAL`;

          return script;
        });

        const multisigBitcoinScript = bitcoin.script.toASM(multisigScript.leaf.output);

        // Check if the script is correctly assembled
        expect(possibleScripts.includes(multisigBitcoinScript)).toBeTruthy();
      }

      const scriptTree: Taptree = sortScriptsIntoTree(multisig.multisigScripts)!;

      const multisigPayment = bitcoin.payments.p2tr({
        internalPubkey: toXOnly(H),
        scriptTree,
        network,
      });

      expect(multisigPayment.address).toEqual(multisig.multisig.address)
    });
  },
  {
    concurrent: true,
  },
)