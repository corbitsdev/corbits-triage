/** How many times a model step is tried before its failure fails the review. */
export const MODEL_ATTEMPTS = 3;

/** The words a model step's error starts its cause with; the failed run's log keeps the rest. */
export const UNREADABLE = "reader: no findings list in the answer";
export const NO_VERDICT = "reader: no verdict and reason in the answer";
export const MODEL_FAILED = "inference failed";
export const NO_CHECKOUT = "reader: no checkout";
