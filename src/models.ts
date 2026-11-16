// The cloud models Snap uses, in one place, so the reader and the cost counter can never disagree.

/** The quick, cheap cloud model that reads most invoices. */
export const CLOUD_MODEL = "gemini-3.5-flash-lite";

/** A stronger cloud model, used only when the quick read does not add up or the quick model is busy. */
export const STRONG_MODEL = "gemini-3.6-flash";
