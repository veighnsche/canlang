/** Existing builtin oracle result; no runtime conversion is added. */
export interface NumberObservation {
  inputBits: string;
  observedBits: string;
  stringText: string;
  jsonTokenText: string;
}

export function observeNumber(inputBits: string): NumberObservation;
