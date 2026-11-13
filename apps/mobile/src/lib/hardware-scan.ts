import { type HardwareImport, readHardwareUr } from '@honey-wallet/keyring/hardware-qr';
import { URDecoder } from '@ngraveio/bc-ur';

/**
 * Putting together a QR hardware wallet's account code. Keystone shows a long code as an
 * animated QR (a fountain-coded `ur:…/n-m/…` per frame), so the scanner feeds every frame
 * in until enough have arrived, in any order, with repeats and gaps.
 */
export type HardwareScan =
  /** `foreign`: the frame was some other QR code (an address, a link), not an account code. */
  | { state: 'scanning'; progress: number; foreign?: boolean }
  | { state: 'done'; result: HardwareImport }
  | { state: 'error'; message: string };

export const isHardwareUr = (text: string) =>
  /^ur:(crypto-hdkey|crypto-multi-accounts)\//i.test(text.trim());

export function createHardwareScanner() {
  let decoder = new URDecoder();
  // Frames this decoder took: a refused frame after some were taken means a new code.
  let taken = 0;
  const reset = () => {
    decoder = new URDecoder();
    taken = 0;
  };
  const take = (part: string) => {
    try {
      // bc-ur returns false (rather than throwing) for a frame of another type or
      // checksum, i.e. the device switched to a different code.
      return decoder.receivePart(part);
    } catch {
      return false;
    }
  };
  return {
    /** One frame from the camera. Anything that isn't part of the code is ignored. */
    feed(text: string): HardwareScan {
      const part = text.trim().toLowerCase();
      if (!isHardwareUr(part))
        return { state: 'scanning', progress: progressOf(decoder), foreign: true };
      if (take(part)) taken++;
      else if (taken === 0 && !/\/\d+-\d+\//.test(part)) {
        // A whole (single-frame) code that doesn't decode: say so rather than wait forever.
        reset();
        return { state: 'error', message: 'That code didn’t read right. Scan it again' };
      } else if (taken > 0) {
        // A frame from a different code (the device switched accounts): start over on it.
        reset();
        if (take(part)) taken++;
      }
      if (!decoder.isComplete()) return { state: 'scanning', progress: progressOf(decoder) };
      if (!decoder.isSuccess()) {
        reset();
        return { state: 'error', message: 'That code didn’t read right. Scan it again' };
      }
      try {
        const ur = decoder.resultUR();
        const result = readHardwareUr(ur.type, new Uint8Array(ur.cbor));
        if (!result.accounts.length) {
          // Start fresh, or every later frame would repeat this (a done decoder takes no more).
          reset();
          return { state: 'error', message: 'No Ethereum accounts in that code' };
        }
        reset();
        return { state: 'done', result };
      } catch (error) {
        reset();
        return {
          state: 'error',
          message:
            error instanceof Error && /private key/.test(error.message)
              ? error.message
              : 'That isn’t an account code. On the device, pick Connect Software Wallet',
        };
      }
    },
  };
}

const progressOf = (decoder: URDecoder) => {
  const p = decoder.estimatedPercentComplete();
  return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
};

/** The scanned accounts, handed from the scanner to the picker in memory, never as params. */
let held: HardwareImport | null = null;

export function holdHardwareImport(result: HardwareImport) {
  held = result;
}

export function takeHardwareImport() {
  const result = held;
  held = null;
  return result;
}
