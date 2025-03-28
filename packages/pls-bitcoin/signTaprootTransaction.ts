import { Psbt } from "bitcoinjs-lib";
import { ECPairInterface } from "ecpair"
import { createKeyTweaker } from "./createKeyTweaker.js";

type SignTaprootTransactionArgs = {
  psbt: Psbt;
  signer: ECPairInterface;
  tweak: Buffer;
}

export async function signTaprootTransaction({
  psbt,
  signer,
  tweak,
}: SignTaprootTransactionArgs) {
  const tweakedSigner = (() => {
    const tweaker = createKeyTweaker({
      pubkey: signer.publicKey,
      privkey: signer.privateKey,
    });

    return tweaker.tweakEcpair(tweak);
  })();

  await psbt.signAllInputsAsync(tweakedSigner);

  return psbt;
}
